/* jshint esnext:true, node:true */
"use strict";
const {
    Cc,
    Ci,
    Cr
} = require("chrome");
const {
    add,
    remove
} = require("sdk/util/array");
const _self = require("sdk/self");
const pageMod = require("sdk/page-mod");
const events = require("sdk/system/events");
const utils = require("sdk/window/utils");
const clipboard = require("sdk/clipboard");
let prefs = require("sdk/simple-prefs").prefs;
//  list of current workers
const workers = [];
const pageMods = {};
const common = require("./lib/common");
const _package = JSON.parse(_self.data.load("../package.json"));
const allDrivers = {};
const externURL = _self.data.url().slice(0, -5) + "node_modules/";
// then extern drivers
Object.keys(_package.sites).forEach((d) =>
    allDrivers[d] = require(_package.sites[d]));
const drivers = Object.keys(allDrivers).filter(drvName =>
    prefs["disable" + drvName] === false);

const onWorkerAttach = (drvName, listen) => (worker) => {
    logify("onAttach", worker);
    //send current Addon preferences to content-script
    let _prefs = {};
    for (let pref in prefs)
        _prefs[pref] = prefs[pref];
    _prefs.driver = drvName;
    _prefs.addon = {
        id: _self.id,
        version: _self.version
    };
    worker.port.emit("preferences", _prefs);
    add(workers, worker);
    worker.port.on("prefChang", (pref) =>
        prefs[pref.name] = pref.val);
    worker.port.on("disable", () =>
        prefs["disable" + drvName] = true);
    worker.port.on("setClipboard", (txt) => clipboard.set(txt));
    for (let evt in listen) {
        logify("Add listener:", evt);
        worker.port.on(evt, (obj) => {
            listen[evt](obj, worker);
        });
    }
    worker.on("detach", function(e) {
        remove(workers, this);

    });
};

drivers.forEach(setupDriver);

function setupDriver(drvName) {
    let driver = allDrivers[drvName];
    let drvPath = externURL + _package.sites[drvName] + "/";
    let scripts, styles;
    if (driver.match === void(0))
        return;
    scripts = common.inject
        .concat((driver.inject || []).map(u => drvPath + u))
        .map(i => _self.data.url(i));
    styles = common.style
        .concat((driver.style || []).map(u => drvPath + u))
        .map(i => _self.data.url(i));
    pageMods[drvName] = pageMod.PageMod({
        include: driver.match,
        contentScriptFile: scripts,
        contentStyleFile: styles,
        contentScriptWhen: driver.when || "ready",
        onAttach: onWorkerAttach(drvName, driver.listen)
    });
}

function listener(event) {
    let channel = event.subject.QueryInterface(Ci.nsIHttpChannel);
    let url = event.subject.URI.spec;
    for (let drvName of drivers) {
        let driver = allDrivers[drvName];
        for (let redirect of(driver.redirect || [])) {
            if (redirect.src.test(url)) {
                channel.redirectTo(Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService).newURI(
                    String.replace(url, redirect.src, redirect.funct),
                    null,
                    null));
                logify("Redirect:", url);
                return;
            }
        }
        for (let block of(driver.block || [])) {
            if (block.test(url)) {
                channel.cancel(Cr.NS_BINDING_ABORTED);
                logify("Block:", url);
                return;
            }
        }
    }
}

//on Addon prefernces change, send the changes to content-script
require("sdk/simple-prefs").on("", function prefChangeHandler(pref) {
    if (pref === "volume" && prefs.volume > 100)
        prefs.volume = 100;
    else if (pref === "volume" && prefs.volume < 0)
        prefs.volume = 0;
    else if (pref.startsWith("disable")) {
        let drvName = /^disable(.+)/.exec(pref)[1];
        if (prefs[pref] === false) {
            add(drivers, drvName);
            setupDriver(drvName);
        } else {
            remove(drivers, drvName);
            pageMods[drvName].destroy();
        }
    } else
        workersPrefHandler(pref);
});

function workersPrefHandler(pref) {
    for (let worker of workers)
        worker.port.emit("prefChanged", {
            name: pref,
            value: prefs[pref]
        });
}

function logify(...args) {
    args.unshift("[CORE]");
    dump(args.join(" ") + "\n");
}

exports.main = () => {
    events.on("http-on-modify-request", listener);
};
exports.onUnload = (reason) => {
    events.off("http-on-modify-request", listener);
};
