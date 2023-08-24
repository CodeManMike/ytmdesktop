import { app, autoUpdater, BrowserView, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from "electron";
import ElectronStore from "electron-store";
import path from "path";

import playerStateStore, { PlayerState, VideoState } from "./player-state-store";
import { StoreSchema } from "./shared/store/schema";

import CompanionServer from "./integrations/companion-server";
import CustomCSS from "./integrations/custom-css";
import DiscordPresence from "./integrations/discord-presence";
import LastFM from "./integrations/last-fm";
import VolumeRatio from "./integrations/volume-ratio";


// This allows TypeScript to pick up the magic constants that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const SETTINGS_WINDOW_WEBPACK_ENTRY: string;
declare const SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const YTM_VIEW_PRELOAD_WEBPACK_ENTRY: string;

let applicationQuitting = false;
let appUpdateAvailable = false;
let appUpdateDownloaded = false;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  applicationQuitting = true;
  app.quit();
}

const companionServer = new CompanionServer();
const customCss = new CustomCSS();
const discordPresence = new DiscordPresence();
const lastFMScrobbler = new LastFM();
const ratioVolume = new VolumeRatio();

let mainWindow: BrowserWindow = null;
let settingsWindow: BrowserWindow = null;
let ytmView: BrowserView = null;
let tray = null;
let trayContextMenu = null;

// These variables tend to be changed often so we store it in memory and write on close (less disk usage)
let lastUrl = "";
let lastVideoId = "";
let lastPlaylistId = "";

let companionAuthWindowEnableTimeout: NodeJS.Timeout | null = null;

// Single Instances Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on("second-instance", (_, commandLine) => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }

    handleProtocol(commandLine[commandLine.length-1])
  });
}

// Configure the autoupdater
const updateServer = "https://update.electronjs.org";
const updateFeed = `${updateServer}/ytmdesktop/ytmdesktop/${process.platform}-${process.arch}/${app.getVersion()}`;

autoUpdater.setFeedURL({
  url: updateFeed
});
autoUpdater.on('checking-for-update', () => {
  if (settingsWindow) {
    settingsWindow.webContents.send("app:checkingForUpdates");
  }
});
autoUpdater.on("update-available", () => {
  appUpdateAvailable = true;
  if (settingsWindow) {
    settingsWindow.webContents.send("app:updateAvailable");
  }
});
autoUpdater.on("update-not-available", () => {
  if (settingsWindow) {
    settingsWindow.webContents.send("app:updateNotAvailable");
  }
});
autoUpdater.on("update-downloaded", () => {
  appUpdateDownloaded = true;
  if (settingsWindow) {
    settingsWindow.webContents.send("app:updateDownloaded");
  }
});
/*
TEMPORARY UPDATE CHECK DISABLE WHILE DEVELOPMENT OCCURS (This will always have errors for now until a release occurs)
setInterval(() => {
  autoUpdater.checkForUpdates()
}, 1000 * 60 * 10);
*/

// Protocol handler
function handleProtocol(url: string) {
  const urlPaths = url.split('://')[1];
  if (urlPaths) {
    const paths = urlPaths.split("/");
    if (paths.length > 0) {
      switch (paths[0]) {
        case "play": {
          if (paths.length >= 2) {
            const videoId = paths[1];
            const playlistId = paths[2];
            
            if (ytmView) {
              ytmView.webContents.send("remoteControl:execute", "navigate", {
                watchEndpoint: {
                  videoId: videoId,
                  playlistId: playlistId
                }
              });
            }
          }
        }
      }
    }
  }
}

if (app.isPackaged && !app.isDefaultProtocolClient("ytmd")) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("ytmd", process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient("ytmd", process.execPath);
  }
}

// Create the persistent config store
const store = new ElectronStore<StoreSchema>({
  watch: true,
  defaults: {
    metadata: {
      version: 1
    },
    general: {
      hideToTrayOnClose: false,
      showNotificationOnSongChange: false,
      startOnBoot: false,
      startMinimized: false,
      disableHardwareAcceleration: false
    },
    appearance: {
      alwaysShowVolumeSlider: false,
      customCSSEnabled: false,
      customCSSPath: null
    },
    playback: {
      continueWhereYouLeftOff: true,
      continueWhereYouLeftOffPaused: true,
      progressInTaskbar: false,
      enableSpeakerFill: false,
      ratioVolume: false
    },
    integrations: {
      companionServerEnabled: false,
      companionServerAuthWindowEnabled: null,
      companionServerAuthTokens: null,
      discordPresenceEnabled: false,
      lastFMEnabled: false
    },
    shortcuts: {
      playPause: "",
      next: "",
      previous: "",
      thumbsUp: "",
      thumbsDown: "",
      volumeUp: "",
      volumeDown: ""
    },
    state: {
      lastUrl: "https://music.youtube.com/",
      lastVideoId: "",
      lastPlaylistId: "",
      companionServerAuthWindowEnableTime: null,
      windowBounds: null,
      windowMaximized: false
    },
    lastfm: {
      api_key: "2a69bcf769a7a28a8bf2f6a5100accad",
      secret: "46eea23770a459a49eb4d26cbf46b41c",
      token: null,
      sessionKey: null
    },
    developer: {
      enableDevTools: false
    }
  }
});
store.onDidAnyChange((newState, oldState) => {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send("settings:stateChanged", newState, oldState);
  }

  if (ytmView !== null) {
    ytmView.webContents.send("settings:stateChanged", newState, oldState);
  }

  // Setting start on boot in development tends to cause a blank electron executable to start on boot so let's never set that
  if (process.env.NODE_ENV !== "development") {
    app.setLoginItemSettings({
      openAtLogin: newState.general.startOnBoot
    });
  }

  if (newState.appearance.customCSSEnabled) {
    customCss.provide(store, ytmView);
  }
  if (newState.appearance.customCSSEnabled && !oldState.appearance.customCSSEnabled) {
    customCss.enable();
  }
  else if (!newState.appearance.customCSSEnabled) {
    customCss.disable();
  }

  if (newState.playback.ratioVolume) {
    ratioVolume.provide(ytmView);
  }
  if (newState.playback.ratioVolume && !oldState.playback.ratioVolume) {
    ratioVolume.enable();
  }
  else if (!newState.playback.ratioVolume) {
    ratioVolume.disable();
  }

  let companionServerAuthWindowEnabled = false;
  try {
    companionServerAuthWindowEnabled =
      safeStorage.decryptString(Buffer.from(newState.integrations.companionServerAuthWindowEnabled, "hex")) === "true" ? true : false;
  } catch {
    /* do nothing, value is false */
  }

  if (newState.integrations.companionServerEnabled) {
    companionServer.provide(store, ytmView);
  }
  if (newState.integrations.companionServerEnabled && !oldState.integrations.companionServerEnabled) {
    companionServer.enable();
  } else if (!newState.integrations.companionServerEnabled) {
    companionServer.disable();

    if (companionServerAuthWindowEnabled) {
      store.set("integrations.companionServerAuthWindowEnabled", null);
      store.set("state.companionServerAuthWindowEnableTime", null);
      clearInterval(companionAuthWindowEnableTimeout);
      companionAuthWindowEnableTimeout = null;
      companionServerAuthWindowEnabled = false;
    }
  }

  if (companionServerAuthWindowEnabled) {
    if (!companionAuthWindowEnableTimeout) {
      companionAuthWindowEnableTimeout = setTimeout(() => {
        store.set("integrations.companionServerAuthWindowEnabled", null);
        store.set("state.companionServerAuthWindowEnableTime", null);
        companionAuthWindowEnableTimeout = null;
      }, 300 * 1000);
      store.set("state.companionServerAuthWindowEnableTime", safeStorage.encryptString(new Date().toISOString()).toString("hex"));
    }
  }

  if (newState.integrations.discordPresenceEnabled) {
    discordPresence.enable();
  } else {
    discordPresence.disable();
  }

  if (newState.integrations.lastFMEnabled) {
    lastFMScrobbler.provide(store);
    lastFMScrobbler.enable();
  } else {
    lastFMScrobbler.disable();
  }

  registerShortcuts();
});

if (store.get('general').disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

if (store.get('appearance').customCSSEnabled) {
  customCss.provide(store, ytmView);
  customCss.enable();
}

if (store.get('playback').enableSpeakerFill) {
  app.commandLine.appendSwitch('try-supported-channel-layouts');
}

if (store.get('playback').ratioVolume) {
  ratioVolume.provide(ytmView);
  ratioVolume.enable();
}

// Integrations setup
// CompanionServer
/*companionServer.addEventListener((command, value) => {
  ytmView.webContents.send("remoteControl:execute", command, value);
});*/
if (store.get("integrations").companionServerEnabled) {
  companionServer.provide(store, ytmView);
  companionServer.enable();
}

// DiscordPresence
if (store.get("integrations").discordPresenceEnabled) {
  discordPresence.enable();
}

// LastFM
if (store.get("integrations").lastFMEnabled) {
  lastFMScrobbler.provide(store);
  lastFMScrobbler.enable();
}

function integrationsSetupAppReady() {
  let companionServerAuthWindowEnabled = false;
  try {
    companionServerAuthWindowEnabled =
      safeStorage.decryptString(Buffer.from(store.get("integrations").companionServerAuthWindowEnabled, "hex")) === "true" ? true : false;
  } catch {
    /* do nothing, value is false */
  }

  if (companionServerAuthWindowEnabled) {
    let companionAuthEnableTimeSate = null;
    try {
      companionAuthEnableTimeSate = safeStorage.decryptString(Buffer.from(store.get("state").companionServerAuthWindowEnableTime, "hex"));
    } catch {
      /* do nothing, value is not valid */
    }

    if (companionAuthEnableTimeSate) {
      const currentDateTime = new Date();
      const enableDateTime = new Date(companionAuthEnableTimeSate);

      const timeDifference = currentDateTime.getTime() - enableDateTime.getTime();
      if (timeDifference >= 300 * 1000) {
        store.set("integrations.companionServerAuthWindowEnabled", null);
        store.set("state.companionServerAuthWindowEnableTime", null);
      } else {
        companionAuthWindowEnableTimeout = setTimeout(
          () => {
            store.set("integrations.companionServerAuthWindowEnabled", null);
            store.set("state.companionServerAuthWindowEnableTime", null);
            companionAuthWindowEnableTimeout = null;
          },
          300 * 1000 - timeDifference
        );
      }
    } else {
      store.set("integrations.companionServerAuthWindowEnabled", null);
      store.set("state.companionServerAuthWindowEnableTime", null);
    }
  }
}

function setupTaskbarFeatures() {
  if (!store.get("playback.progressInTaskbar") && process.platform !== "win32") {
    return;
  }

  // Setup Taskbar Icons
  const assetFolder = path.join(process.env.NODE_ENV === "development" ? path.join(app.getAppPath(), "src/assets") : process.resourcesPath);
  if (process.platform === "win32") {
    mainWindow.setThumbarButtons([
      {
        tooltip: "Previous",
        icon: nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-previous-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "previous");
          }
        }
      },
      {
        tooltip: "Play/Pause",
        icon: nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "playPause");
          }
        }
      },
      {
        tooltip: "Next",
        icon: nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-next-button.png")),
        flags: ["disabled"],
        click() {
          if (ytmView) {
            ytmView.webContents.send("remoteControl:execute", "next");
          }
        }
      }
    ]);
  }
  playerStateStore.addEventListener((state: PlayerState) => {
    const hasVideo = !!state.videoDetails;
    const isPlaying = state.trackState === VideoState.Playing;

    if (process.platform == "win32") {
      const taskbarFlags = [];
      if (!hasVideo) {
        taskbarFlags.push("disabled");
      }

      mainWindow.setThumbarButtons([
        {
          tooltip: "Previous",
          icon: nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-previous-button.png")),
          flags: taskbarFlags,
          click() {
            if (ytmView) {
              ytmView.webContents.send("remoteControl:execute", "previous");
            }
          }
        },
        {
          tooltip: "Play/Pause",
          icon: isPlaying
            ? nativeImage.createFromPath(path.join(assetFolder, "icons/controls/pause-button.png"))
            : nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-button.png")),
          flags: taskbarFlags,
          click() {
            if (ytmView) {
              ytmView.webContents.send("remoteControl:execute", "playPause");
            }
          }
        },
        {
          tooltip: "Next",
          icon: nativeImage.createFromPath(path.join(assetFolder, "icons/controls/play-next-button.png")),
          flags: taskbarFlags,
          click() {
            if (ytmView) {
              ytmView.webContents.send("remoteControl:execute", "next");
            }
          }
        }
      ]);
    }

    if (mainWindow && store.get("playback.progressInTaskbar")) {
      mainWindow.setProgressBar(hasVideo ? state.videoProgress / state.videoDetails.durationSeconds : -1, {
        mode: isPlaying ? "normal" : "paused"
      });
    }
  });

  store.onDidChange("playback", (newValue, oldValue) => {
    if (mainWindow && newValue.progressInTaskbar !== oldValue.progressInTaskbar && !newValue.progressInTaskbar) {
      mainWindow.setProgressBar(-1);
    }
  });
}

// Shortcut registration
function registerShortcuts() {
  const shortcuts = store.get("shortcuts");

  globalShortcut.unregisterAll();

  if (shortcuts.playPause) {
    globalShortcut.register(shortcuts.playPause, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "playPause");
      }
    });
  }

  if (shortcuts.next) {
    globalShortcut.register(shortcuts.next, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "next");
      }
    });
  }

  if (shortcuts.previous) {
    globalShortcut.register(shortcuts.previous, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "previous");
      }
    });
  }

  if (shortcuts.thumbsUp) {
    globalShortcut.register(shortcuts.thumbsUp, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "thumbsUp");
      }
    });
  }

  if (shortcuts.thumbsDown) {
    globalShortcut.register(shortcuts.thumbsDown, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "thumbsDown");
      }
    });
  }

  if (shortcuts.volumeUp) {
    globalShortcut.register(shortcuts.volumeUp, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "volumeUp");
      }
    });
  }

  if (shortcuts.volumeDown) {
    globalShortcut.register(shortcuts.volumeDown, () => {
      if (ytmView) {
        ytmView.webContents.send("remoteControl:execute", "volumeDown");
      }
    });
  }
}

// Functions which call to mainWindow renderer
function sendMainWindowStateIpc() {
  if (mainWindow !== null) {
    mainWindow.webContents.send("mainWindow:stateChanged", {
      minimized: mainWindow.isMinimized(),
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    });
  }
}

// Functions with call to ytmView renderer
function ytmViewNavigated() {
  if (ytmView !== null) {
    lastUrl = ytmView.webContents.getURL();
    ytmView.webContents.send("ytmView:navigationStateChanged", {
      canGoBack: ytmView.webContents.canGoBack(),
      canGoForward: ytmView.webContents.canGoForward()
    });
  }
}

// Functions which call to settingsWindow renderer
function sendSettingsWindowStateIpc() {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send("settingsWindow:stateChanged", {
      minimized: settingsWindow.isMinimized(),
      maximized: settingsWindow.isMaximized()
    });
  }
}

// Handles any navigation or window opening from ytmView
function openExternalFromYtmView(urlString: string) {
  const url = new URL(urlString);
  const domainSplit = url.hostname.split(".");
  domainSplit.reverse();
  const domain = `${domainSplit[1]}.${domainSplit[0]}`;
  if (domain === "google.com" || domain === "youtube.com") {
    shell.openExternal(urlString);
  }
}

const createOrShowSettingsWindow = (): void => {
  if (mainWindow === null) {
    return;
  }

  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }

  const mainWindowBounds = mainWindow.getBounds();

  // Create the browser window.
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.round(mainWindowBounds.x + (mainWindowBounds.width / 2 - 400)),
    y: Math.round(mainWindowBounds.y + (mainWindowBounds.height / 2 - 300)),
    minimizable: false,
    maximizable: false,
    resizable: false,
    frame: false,
    show: false,
    parent: mainWindow,
    modal: (process.platform !== 'darwin'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#BBBBBB',
      height: 36
    },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      devTools: store.get("developer.enableDevTools")
    }
  });

  // Attach events to settings window
  settingsWindow.on("maximize", sendSettingsWindowStateIpc);
  settingsWindow.on("unmaximize", sendSettingsWindowStateIpc);
  settingsWindow.on("minimize", sendSettingsWindowStateIpc);
  settingsWindow.on("restore", sendSettingsWindowStateIpc);

  settingsWindow.once("closed", () => {
    settingsWindow = null;
  });

  settingsWindow.webContents.setWindowOpenHandler(details => {
    if (details.url === "https://github.com/ytmdesktop/ytmdesktop" || details.url === "https://ytmdesktop.app/") {
      shell.openExternal(details.url);
    }

    return {
      action: "deny"
    };
  });

  settingsWindow.webContents.on("will-navigate", event => {
    event.preventDefault();
  });

  settingsWindow.on("ready-to-show", () => {
    settingsWindow.show();
  })

  // and load the index.html of the app.
  settingsWindow.loadURL(SETTINGS_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools.
  if (process.env.NODE_ENV === "development") {
    settingsWindow.webContents.openDevTools({
      mode: "detach"
    });
  }
};

const createMainWindow = (): void => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    show: false,
    icon: './assets/icons/ytmd.png',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#BBBBBB',
      height: 36
    },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      devTools: store.get("developer.enableDevTools")
    }
  });
  const windowBounds = store.get("state").windowBounds;
  const windowMaximized = store.get("state").windowMaximized;
  if (windowBounds) {
    mainWindow.setBounds(windowBounds);
  }
  if (windowMaximized) {
    mainWindow.maximize();
  }

  // Create the YouTube Music view
  ytmView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      partition: "persist:ytmview",
      preload: YTM_VIEW_PRELOAD_WEBPACK_ENTRY
    }
  });
  companionServer.provide(store, ytmView);
  customCss.provide(store, ytmView);
  ratioVolume.provide(ytmView);

  // This block of code adding the browser view setting the bounds and removing it is a temporary fix for a bug in YTMs UI
  // where a small window size will lock the scrollbar and have difficulty unlocking it without changing the guide bar collapse state
  if (ytmView !== null && mainWindow !== null) {
    mainWindow.addBrowserView(ytmView);
    ytmView.setBounds({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    });
    mainWindow.removeBrowserView(ytmView);
  }

  let navigateDefault = true;

  const continueWhereYouLeftOff: boolean = store.get("playback.continueWhereYouLeftOff");
  if (continueWhereYouLeftOff) {
    const lastUrl: string = store.get("state.lastUrl");
    if (lastUrl) {
      if (lastUrl.startsWith("https://music.youtube.com/")) {
        ytmView.webContents.loadURL(lastUrl);
        navigateDefault = false;
      }
    }
  }

  if (navigateDefault) {
    ytmView.webContents.loadURL("https://music.youtube.com/");
    store.set("state.lastUrl", "https://music.youtube.com/");
  }

  // Attach events to ytm view
  ytmView.webContents.on("will-navigate", (event) => {
    if (
      !event.url.startsWith("https://consent.youtube.com/") &&
      !event.url.startsWith("https://accounts.google.com/") &&
      !event.url.startsWith("https://accounts.youtube.com/") &&
      !event.url.startsWith("https://music.youtube.com/") &&
      !event.url.startsWith("https://www.youtube.com/signin")
    ) {
      event.preventDefault();

      openExternalFromYtmView(event.url);
    }
  });
  ytmView.webContents.on("did-navigate", ytmViewNavigated);
  ytmView.webContents.on("did-navigate-in-page", ytmViewNavigated);
  ytmView.webContents.on("enter-html-full-screen", () => {
    if (mainWindow) {
      mainWindow.setFullScreen(true);
    }
  });
  ytmView.webContents.on("leave-html-full-screen", () => {
    if (mainWindow) {
      mainWindow.setFullScreen(false);
    }
  });

  ytmView.webContents.setWindowOpenHandler(details => {
    openExternalFromYtmView(details.url);
    
    return {
      action: "deny"
    };
  });

  // Attach events to main window
  mainWindow.on("resize", () => {
    setTimeout(() => {
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36
      });
    });
  });

  mainWindow.on("enter-full-screen", () => {
    setTimeout(() => {
      ytmView.setBounds({
        x: 0,
        y: 0,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height
      });
    });
    sendMainWindowStateIpc();
  });
  mainWindow.on("leave-full-screen", () => {
    setTimeout(() => {
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36
      });
    });
    sendMainWindowStateIpc();
  });
  mainWindow.on("maximize", sendMainWindowStateIpc);
  mainWindow.on("unmaximize", sendMainWindowStateIpc);
  mainWindow.on("minimize", sendMainWindowStateIpc);
  mainWindow.on("restore", sendMainWindowStateIpc);
  mainWindow.on("close", event => {
    if (!applicationQuitting && (store.get("general").hideToTrayOnClose || process.platform === "darwin")) {
      event.preventDefault();
      mainWindow.hide();
    }

    store.set("state.windowBounds", mainWindow.getNormalBounds());
    store.set("state.windowMaximized", mainWindow.isMaximized());
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return {
      action: "deny"
    };
  });

  mainWindow.webContents.on("will-navigate", event => {
    event.preventDefault();
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools.
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({
      mode: "detach"
    });
    ytmView.webContents.openDevTools({
      mode: "detach"
    });
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  // Handle main window ipc
  ipcMain.on("mainWindow:minimize", () => {
    if (mainWindow !== null) {
      mainWindow.minimize();
    }
  });

  ipcMain.on("mainWindow:maximize", () => {
    if (mainWindow !== null) {
      mainWindow.maximize();
    }
  });

  ipcMain.on("mainWindow:restore", () => {
    if (mainWindow !== null) {
      mainWindow.restore();
    }
  });

  ipcMain.on("mainWindow:close", () => {
    if (mainWindow !== null) {
      if (store.get("general").hideToTrayOnClose || process.platform === "darwin") {
        mainWindow.hide();
      } else {
        applicationQuitting = true;
        app.quit();
      }
    }
  });

  ipcMain.on("mainWindow:requestWindowState", () => {
    sendMainWindowStateIpc();
  });

  // Handle settings window ipc
  ipcMain.on("settingsWindow:open", () => {
    createOrShowSettingsWindow();
  });

  ipcMain.on("settingsWindow:minimize", () => {
    if (settingsWindow !== null) {
      settingsWindow.minimize();
    }
  });

  ipcMain.on("settingsWindow:maximize", () => {
    if (settingsWindow !== null) {
      settingsWindow.maximize();
    }
  });

  ipcMain.on("settingsWindow:restore", () => {
    if (settingsWindow !== null) {
      settingsWindow.restore();
    }
  });

  ipcMain.on("settingsWindow:close", () => {
    if (settingsWindow !== null) {
      settingsWindow.close();
    }
  });

  ipcMain.on('settingsWindow:restartapplication', () => {
    app.relaunch();
    applicationQuitting = true;
    app.quit();
  });

  ipcMain.on("settingsWindow:restartApplicationForUpdate", () => {
    applicationQuitting = true;
    autoUpdater.quitAndInstall();
  })

  // Handle ytm view ipc
  ipcMain.on("ytmView:loaded", () => {
    if (ytmView !== null && mainWindow !== null) {
      mainWindow.addBrowserView(ytmView);
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36
      });
    }
  });

  ipcMain.on("ytmView:videoProgressChanged", (event, progress) => {
    playerStateStore.updateVideoProgress(progress);
  });

  ipcMain.on("ytmView:videoStateChanged", (event, state) => {
    // ytm state mapping definitions
    // -1 -> Unknown (Seems tied to no buffer data, but cannot confirm)
    // 1 -> Playing
    // 2 -> Paused
    // 3 -> Buffering
    // 5 -> Unknown (Only happens when loading new songs - unsure what this is for)

    // ytm state flow
    // Play Button Click
    //   -1 -> 5 -> -1 -> 3 -> 1
    // First Play Button Click (Only happens when the player is first loaded)
    //   -1 -> 3 -> 1
    // Previous/Next Song Click
    //   -1 -> 5 -> -1 -> 5 -> -1 -> 3 -> 1

    playerStateStore.updateVideoState(state);
  });

  ipcMain.on("ytmView:videoDataChanged", (event, videoDetails, playlistId) => {
    lastVideoId = videoDetails.videoId;
    lastPlaylistId = playlistId;

    playerStateStore.updateVideoDetails(videoDetails, playlistId);
  });

  ipcMain.on("ytmView:storeStateChanged", (event, queue) => {
    playerStateStore.updateQueue(queue);
  });

  ipcMain.on("ytmView:switchFocus", (event, context) => {
    if (context === "main") {
      if (mainWindow && ytmView.webContents.isFocused()) {
        mainWindow.webContents.focus();
      }
    } else if (context === "ytm") {
      if (ytmView && mainWindow.webContents.isFocused()) {
        ytmView.webContents.focus();
      }
    }
  });

  // Handle settings store ipc
  ipcMain.on("settings:set", (event, key: string, value?: string) => {
    store.set(key, value);
  });

  ipcMain.handle("settings:get", (event, key: string) => {
    return store.get(key);
  });

  ipcMain.handle("settings:reset", (event, key: keyof StoreSchema) => {
    store.reset(key);
  });

  // Handle safeStorage ipc
  ipcMain.handle("safeStorage:decryptString", (event, value: string) => {
    if (value) {
      return safeStorage.decryptString(Buffer.from(value, "hex"));
    } else {
      return null;
    }
  });

  ipcMain.handle("safeStorage:encryptString", (event, value: string) => {
    return safeStorage.encryptString(value).toString("hex");
  });

  // Handle app ipc
  ipcMain.handle("app:getVersion", () => {
    return app.getVersion();
  })

  ipcMain.on("app:checkForUpdates", () => {
    // autoUpdater downloads automatically and calling checkForUpdates causes duplicate install
    if (!appUpdateAvailable || !appUpdateDownloaded) {
      autoUpdater.checkForUpdates();
    }
  })

  ipcMain.handle("app:isUpdateAvailable", () => {
    return appUpdateAvailable;
  })

  ipcMain.handle("app:isUpdateDownloaded", () => {
    return appUpdateDownloaded;
  })

  // Create the permission handlers
  session.fromPartition("persist:ytmview").setPermissionCheckHandler((webContents, permission) => {
    if (webContents == ytmView.webContents) {
      if (permission === "fullscreen") {
        return true;
      }
    }

    return false;
  });
  session.fromPartition("persist:ytmview").setPermissionRequestHandler((webContents, permission, callback) => {
    if (webContents == ytmView.webContents) {
      if (permission === "fullscreen") {
        return callback(true);
      }
    }

    return callback(false);
  });

  // Register global shortcuts
  registerShortcuts();

  // Run functions which rely on ready event
  integrationsSetupAppReady();

  // Create the tray
  tray = new Tray(
    path.join(
      process.env.NODE_ENV === "development" ? path.join(app.getAppPath(), "src/assets") : process.resourcesPath,
      process.platform === "win32" ? "icons/tray.ico" : "icons/trayTemplate.png"
    )
  );
  trayContextMenu = Menu.buildFromTemplate([
    {
      label: "YouTube Music Desktop",
      type: "normal",
      enabled: false
    },
    {
      type: "separator"
    },
    {
      label: "Play/Pause",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "playPause");
      }
    },
    {
      label: "Previous",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "previous");
      }
    },
    {
      label: "Next",
      type: "normal",
      click: () => {
        ytmView.webContents.send("remoteControl:execute", "next");
      }
    },
    {
      type: "separator"
    },
    {
      label: "Quit",
      type: "normal",
      click: () => {
        applicationQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip("YouTube Music Desktop");
  tray.setContextMenu(trayContextMenu);
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  createMainWindow();

  // Setup taskbar features
  setupTaskbarFeatures();
});

app.on('before-quit', () => {
  store.set("state.lastUrl", lastUrl);
  store.set("state.lastVideoId", lastVideoId);
  store.set("state.lastPlaylistId", lastPlaylistId);
})

app.on('open-url', (_, url) => {
  handleProtocol(url);
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    applicationQuitting = true;
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
