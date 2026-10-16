/* Browser adapter for the installed, unmodified Hermes Desktop renderer.
 * Chat/layout/settings are upstream Hermes code, loaded through the laptop.
 * No Electron IPC or generic system-command endpoint is exposed here.
 */
(() => {
  const noop = () => {};
  const subscribe = () => noop;
  const events = new EventTarget();
  const initialRevision = document.querySelector(
    'meta[name="nectit-renderer-revision"]',
  ).content;
  const initialProfile = document.querySelector('meta[name="nectit-profile"]')?.content || "";
  let latestRevision = initialRevision;
  let latestVersion;
  const ws = (profile) =>
    location.origin.replace(/^http/, "ws") +
    "/hermes/api/ws" +
    (profile || initialProfile ? "?profile=" + encodeURIComponent(profile || initialProfile) : "");
  async function local(path, data) {
    const response = await fetch(
      path,
      data
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }
        : {},
    );
    if (response.status === 401) {
      location.replace("/setup/account");
      throw new Error("Sign in to Nectit again.");
    }
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        value.error || "The connected Hermes computer is unavailable.",
      );
    return value;
  }
  function owner(payload = {}) {
    if (
      payload.connectionId &&
      !["nectit", "local"].includes(payload.connectionId)
    )
      throw new Error("Connect this computer through Nectit first.");
  }
  async function api(request) {
    owner(request);
    return local("/local/desktop-api", { ...request, profile: request.profile || initialProfile || undefined });
  }
  function banner(message, label, action) {
    document.querySelector("#nectit-notice")?.remove();
    const bar = document.createElement("div");
    bar.id = "nectit-notice";
    bar.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = message;
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = action;
    bar.append(text, button);
    document.body.append(bar);
  }
  async function revisionCheck() {
    try {
      const value = await local("/local/renderer");
      latestVersion = value.version;
      latestRevision = value.revision;
      if (latestRevision !== initialRevision)
        banner(
          "Hermes has a newer desktop interface on your computer.",
          "Reload workspace",
          () => location.reload(),
        );
    } catch {
      /* An offline laptop is reported by Hermes' own reconnect UI. */
    }
  }
  function descriptor(profile) {
    return {
      baseUrl: location.origin + "/hermes",
      wsUrl: ws(profile),
      token: "",
      authMode: "oauth",
      mode: "remote",
      remoteKind: "url",
      remoteHost: "Hermes computer",
      remoteIdentity: "nectit",
      connectionId: "nectit",
      registryScoped: true,
      sharedRemote: true,
      profile: profile || initialProfile || undefined,
      isFullscreen: !!document.fullscreenElement,
      isMaximized: true,
      customWindowControls: false,
      nativeOverlayWidth: 0,
      windowButtonPosition: null,
      logs: [],
      source: "settings",
    };
  }
  const preference = (name) => {
    try {
      return JSON.parse(localStorage.getItem("nectit." + name) || "null");
    } catch {
      return null;
    }
  };
  const savePreference = (name, value) => {
    localStorage.setItem("nectit." + name, JSON.stringify(value));
    return value;
  };
  const unsupported = async () => {
    throw new Error(
      "This action requires the native Hermes app on your computer.",
    );
  };
  const registry = {
    version: 2,
    primary: "nectit",
    lastUsed: "nectit",
    secureTokenStorage: false,
    launchMode: "last-used",
    connections: [
      {
        id: "nectit",
        kind: "remote",
        label: "Hermes computer",
        url: location.origin + "/hermes",
        authMode: "oauth",
        tokenSet: false,
      },
    ],
  };
  const bridge = {
    glassSupported: false,
    translucencySupported: false,
    localModelsEnabled: false,
    assumeFreshInstall: false,
    localSkin: null,
    api,
    getConnection: async (profile) => {
      await local("/local/renderer");
      return descriptor(profile);
    },
    getConnectionFor: async (payload) => {
      owner(payload);
      await local("/local/renderer");
      return descriptor(payload?.profile);
    },
    getGatewayWsUrl: async (profile) => {
      void revisionCheck();
      return ws(profile);
    },
    getGatewayWsUrlFor: async (payload) => {
      owner(payload);
      return ws(payload?.profile);
    },
    getProfileRoutes: async (profiles) =>
      profiles.map((profile) => ({
        connectionId: "nectit",
        mode: "remote",
        profile,
        targetProfile: profile,
        primary: true,
      })),
    revalidateConnection: async () => {
      await revisionCheck();
      return { ok: true, rebuilt: false };
    },
    touchBackend: async () => ({ ok: true }),
    getBootProgress: async () => ({
      phase: "backend.remote",
      message: "Connected through Nectit",
      progress: 80,
      running: true,
      error: null,
      timestamp: Date.now(),
    }),
    getConnectionConfig: async () => ({
      mode: "remote",
      remoteUrl: location.origin + "/hermes",
      authMode: "oauth",
      source: "settings",
      tokenSet: false,
    }),
    connections: {
      list: async () => registry,
      onChanged: subscribe,
      setLastUsed: async () => ({ ok: true }),
      test: async () => ({ ok: true }),
      save: unsupported,
      remove: unsupported,
      setPrimary: unsupported,
      setLaunchMode: unsupported,
    },
    profile: {
      get: async () => ({ profile: initialProfile || null }),
      getDefault: async () => initialProfile || preference("defaultProfile"),
      setDefault: async (value) => savePreference("defaultProfile", value),
      onDefaultChanged: subscribe,
      onChanged: subscribe,
    },
    settings: {
      getDefaultProjectDir: async () => preference("projectDir") || "",
      setDefaultProjectDir: async (value) =>
        savePreference("projectDir", value),
      pickDefaultProjectDir: unsupported,
    },
    getPoolLimits: async () => ({ maxBackends: 1, idleMs: 600000 }),
    setPoolLimits: unsupported,
    getVersion: async () => {
      await revisionCheck();
      return {
        version: latestVersion || "unknown",
        baseVersion: latestVersion || "unknown",
        source: "local",
        updateMechanism: "external",
        hermesRuntime: { type: "external" },
      };
    },
    getMachineProfile: async () => ({
      platform: "web",
      arch: "unknown",
      totalMemory: 0,
      cpus: 0,
    }),
    getOnBattery: async () => false,
    getRemoteDisplayReason: async () => null,
    getBootstrapState: async () => ({
      active: false,
      log: [],
      error: null,
      steps: [],
      setupChoice: null,
      unsupportedPlatform: null,
    }),
    getSecretStorageEncryption: async () => ({
      enabled: false,
      available: false,
    }),
    getRecentLogs: async () => [],
    claimStartupLatency: async () => false,
    claimAmbientCue: async () => false,
    sanitizeWorkspaceCwd: async (value) => value || "",
    setActiveConnectionRoute: noop,
    setActiveWork: noop,
    setTitleBarTheme: noop,
    setNativeTheme: noop,
    setTranslucency: noop,
    setKeepAwake: noop,
    setDisableF12: noop,
    setF12ShortcutActive: noop,
    setPreviewShortcutActive: noop,
    setPreviewGuestHidden: noop,
    logLine: noop,
    reportRendererError: (error) => console.error("[Hermes renderer]", error),
    writeClipboard: (value) => navigator.clipboard.writeText(value),
    readClipboard: () => navigator.clipboard.readText(),
    openExternal: async (value) => {
      const url = new URL(value);
      if (!["http:", "https:", "mailto:"].includes(url.protocol))
        throw new Error("Unsupported link.");
      window.open(url.href, "_blank", "noopener,noreferrer");
    },
    openWindow: async () => {
      window.open(location.pathname, "_blank", "noopener");
      return { ok: true };
    },
    openSessionWindow: async (sessionId) => {
      window.open(
        location.pathname + "#/" + encodeURIComponent(sessionId),
        "_blank",
        "noopener",
      );
      return { ok: true };
    },
    relaunchApp: async () => location.reload(),
    windowControls: {
      custom: false,
      minimize: noop,
      toggleMaximize: () =>
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen(),
      close: noop,
    },
    windowRelay: { send: noop, onMessage: subscribe },
    zoom: {
      get: async () => ({ level: 0, percent: 100 }),
      factor: () => 1,
      onChanged: subscribe,
      setPercent: noop,
    },
    dataUrlReadMax: { get: async () => 268435456, set: unsupported },
    chatOnboarding: { size: noop },
    desktopMetrics: {
      takeRendererCrashes: async () => [],
      ackRendererCrashes: async () => {},
      setEnabled: async () => {},
    },
    updates: {
      check: async () => {
        await revisionCheck();
        return {
          available: latestRevision !== initialRevision,
          currentVersion: latestVersion,
          latestVersion,
          distance: latestRevision !== initialRevision ? 1 : 0,
          canUpdate: false,
          configured: true,
          channel: "laptop",
        };
      },
      apply: async () => location.reload(),
      onProgress: subscribe,
      takePendingRun: async () => null,
      ackPendingRun: async () => {},
      onPendingRun: subscribe,
    },
    readDir: async (path) =>
      api({ path: "/api/fs/list?path=" + encodeURIComponent(path) }),
    readFileText: async (path) =>
      api({ path: "/api/fs/read-text?path=" + encodeURIComponent(path) }),
    selectPaths: async () => [],
    openSessionInTerminal: unsupported,
    revealLogs: unsupported,
    recycleBackend: unsupported,
    requestMicrophoneAccess: async () => true,
  };
  // Browser pages have no OS-level Electron events. New upstream event
  // subscriptions safely receive an unsubscribe; unknown actions stay absent.
  window.hermesDesktop = new Proxy(bridge, {
    get(target, key) {
      return key in target
        ? target[key]
        : typeof key === "string" && /^on[A-Z]/.test(key)
          ? subscribe
          : undefined;
    },
  });
  window.addEventListener("online", () => {
    events.dispatchEvent(new Event("online"));
    void revisionCheck();
  });
  window.addEventListener("focus", () => void revisionCheck());
  setInterval(revisionCheck, 45000);
  void revisionCheck();
  document.addEventListener("DOMContentLoaded", async () => {
    const controls = document.createElement("nav");
    controls.id = "nectit-controls";
    controls.setAttribute("aria-label", "Nectit connection");
    const home = document.createElement("a");
    home.href = "/setup/computer";
    home.textContent = "nectit";
    home.title = "Connection settings";
    const exit = document.createElement("button");
    exit.textContent = "Sign out";
    exit.onclick = async () => {
      await local("/local/signout", {});
      location.replace("/setup/account");
    };
    const chats = document.createElement("button");
    chats.textContent = "CLI chats";
    chats.onclick = async () => {
      const { openCliChats } = await import("/cli-dialog.js");
      await openCliChats({ local, profile: initialProfile });
    };
    controls.append(home);
    try {
      if ((await local("/local/bootstrap")).features?.cliChats) controls.append(chats);
    } catch { /* Keep connection controls available on older routers. */ }
    controls.append(exit);
    document.body.append(controls);
  });
})();
