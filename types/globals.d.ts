// Types for the extension's plain scripts, checked by `npm run typecheck`.
// Not shipped: only extension/ is packaged.

// The namespace each script adds to (globalThis.ZF). Members are listed by
// name so a misspelt ZF.* is an error; add new ones here.
interface ZFApi {
  // lib/settings.js
  BACKGROUNDS: any;
  SETTINGS_DEFAULTS: any;
  getSettings: any;
  normalizeSettings: any;
  resetSettings: any;
  updateSettings: any;
  // lib/model.js
  BACKUP_FORMAT: any;
  BACKUP_KEY: any;
  FOLDER_KEY: any;
  INTERNAL_CALLS: any;
  ORDER_KEY: any;
  ORIGINAL_URL_KEY: any;
  REMOTE_CALLS: any;
  ROOT: any;
  SPACES_BACKUP_KEY: any;
  SPACE_ICONS: any;
  SPACE_KEY: any;
  SPACE_MENU_ITEMS: any;
  WINDOW_SPACE_KEY: any;
  activeSpaceId: any;
  adoptTab: any;
  applyOrder: any;
  buildView: any;
  changedTabs: any;
  childrenOf: any;
  clearRegular: any;
  closeOldPlaceholders: any;
  closeOrUnload: any;
  createFolder: any;
  createSpace: any;
  deleteSpace: any;
  desiredOrder: any;
  displayOrder: any;
  exportFolders: any;
  folderSpace: any;
  followTab: any;
  getPlace: any;
  importZenFolders: any;
  initWindow: any;
  isDescendant: any;
  isRealUrl: any;
  isSharing: any;
  isWebUrl: any;
  itemsOf: any;
  keptOrder: any;
  loadFolders: any;
  loadSpaces: any;
  local: any;
  metaCache: any;
  migrateNativeGroups: any;
  moveFolderToSpace: any;
  moveItems: any;
  moveSpace: any;
  moveTabs: any;
  moveTabsToSpace: any;
  mutateFolders: any;
  mutateSpaces: any;
  newId: any;
  normalizeAllWindows: any;
  normalizeOrder: any;
  notifyChanged: any;
  parseBackup: any;
  removeFolder: any;
  resolveSpace: any;
  restoreFolders: any;
  restoreFoldersIfMissing: any;
  runQueued: any;
  saveFolders: any;
  saveSpaces: any;
  setAllCollapsed: any;
  setMeta: any;
  setPlace: any;
  showAllSpaces: any;
  showSpaceIn: any;
  switchSpace: any;
  switchSpaceBy: any;
  tabSpace: any;
  updateFolder: any;
  updateSpace: any;
  // lib/unload.js
  UNLOAD_ALARM: any;
  compileNeverUnload: any;
  configureAutoUnload: any;
  getUnloadSettings: any;
  keepEssentialLoaded: any;
  unloadSkipReason: any;
  unloadStaleTabs: any;
  // background.js
  IS_BACKGROUND: any;
  onHideFailed: any;
}

declare var ZF: ZFApi;

// Fields buildView (lib/model.js) adds to tabs for the sidebar.
declare namespace browser.tabs {
  interface Tab {
    zfPlace?: string;
    zfOriginalUrl?: string;
    zfOrder?: number;
    zfOrderStored?: boolean;
    zfForeignSpace?: { id: string; name: string; icon: string };
  }
}

// A folder rename box remembers its selection across redraws (sidebar.js).
interface HTMLInputElement {
  zfSelection?: [number, number];
}
// closest() and querySelector() return Element, but every element the pages
// query is HTML or SVG, and both have dataset.
interface Element {
  readonly dataset: DOMStringMap;
}
