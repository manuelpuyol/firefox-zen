// Runs inside Firefox (chrome privileges) via Marionette; see install.sh.
// arguments[0] = kit directory, arguments[1] = Zen session JSON path or null.
const [kit, sessionPath] = arguments;
const done = arguments[arguments.length - 1];

(async () => {
  const report = {};
  const profile = PathUtils.profileDir;
  report.profile = profile;

  const backup = PathUtils.join(profile, "zen-kit-backup-" + new Date().toISOString().replace(/[:.]/g, "-"));
  await IOUtils.makeDirectory(backup);
  for (const f of ["user.js", "chrome"]) {
    const src = PathUtils.join(profile, f);
    if (await IOUtils.exists(src)) {
      await IOUtils.copy(src, PathUtils.join(backup, f), { recursive: true });
    }
  }
  await IOUtils.writeUTF8(PathUtils.join(backup, "session-before.json"), SessionStore.getBrowserState());
  report.backup = backup;

  await IOUtils.copy(PathUtils.join(kit, "user.js"), PathUtils.join(profile, "user.js"));
  await IOUtils.makeDirectory(PathUtils.join(profile, "chrome"));
  await IOUtils.copy(
    PathUtils.join(kit, "chrome", "userChrome.css"),
    PathUtils.join(profile, "chrome", "userChrome.css")
  );
  report.files = "user.js, chrome/userChrome.css";

  // Zen's toolbar: sidebar toggle, back, forward, reload | URL bar | extensions
  for (const id of ["alltabs-button", "smartwindow-group-tabs-button", "ai-window-toggle"]) {
    if (CustomizableUI.getPlacementOfWidget(id)?.area === "nav-bar") {
      CustomizableUI.removeWidgetFromArea(id);
    }
  }
  ["sidebar-button", "back-button", "forward-button", "stop-reload-button", "urlbar-container", "unified-extensions-button"]
    .forEach((id, i) => CustomizableUI.addWidgetToArea(id, "nav-bar", i));
  report.toolbar = CustomizableUI.getWidgetIdsInArea("nav-bar");

  // Zen-width sidebar
  if (SidebarController._state) {
    SidebarController._state.launcherWidth = 300;
    SidebarController._state.expandedLauncherWidth = 300;
  }

  // Translucency only renders with the default theme; add-on themes (Arc Dark)
  // paint the window opaque. Arc stays installed, just disabled.
  const defaultTheme = await AddonManager.getAddonByID("default-theme@mozilla.org");
  if (defaultTheme && !defaultTheme.isActive) {
    await defaultTheme.enable();
  }
  report.theme = "System theme (needed for translucency)";

  // Older installs flattened Zen subfolders as "Parent / child"; switch them
  // to the leading-space subfolder convention.
  report.renamedGroups = [];
  for (const group of gBrowser.tabGroups) {
    const parts = group.label.split(" / ");
    if (parts.length > 1) {
      group.label = " ".repeat(parts.length - 1) + parts[parts.length - 1];
      report.renamedGroups.push(group.label);
    }
  }

  if (sessionPath) {
    SessionStore.setBrowserState(await IOUtils.readUTF8(sessionPath));
    await new Promise(r => setTimeout(r, 3000));
    report.session = `${gBrowser.tabs.length} tabs, ${gBrowser.tabGroups.length} groups`;
  }

  done(report);
})().catch(e => done({ error: String(e) }));
