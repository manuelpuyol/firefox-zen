#!/usr/bin/env python3
"""Export Zen folders for Zen Folder Tools' "Import folders from Zen".

Writes the folder tree (names, nesting, collapsed state) and the addresses of
the tabs in each folder. Import it from the extension's settings page; open
tabs whose address matches are moved into the matching folder.

Usage: export_zen_folders.py [zen-profile-dir] [output.json]
Defaults: the first Zen profile with a session, ~/Downloads/zen-folders.json
"""

import json
import sys
from pathlib import Path

from zen_to_firefox_session import current_url, read_mozlz4


def find_zen_profile():
    root = Path.home() / "Library/Application Support/zen/Profiles"
    for profile in sorted(root.glob("*")):
        if (profile / "zen-sessions.jsonlz4").exists():
            return profile
    raise SystemExit("No Zen profile with a session found")


def main():
    profile = Path(sys.argv[1]) if len(sys.argv) > 1 else find_zen_profile()
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / "Downloads/zen-folders.json"
    session = read_mozlz4(profile / "zen-sessions.jsonlz4")
    folders = session.get("folders", [])
    ids = {f["id"] for f in folders}

    tabs = []
    for tab in session.get("tabs", []):
        if tab.get("zenEssential") or tab.get("groupId") not in ids:
            continue
        urls = [current_url(tab), ((tab.get("_zenPinnedInitialState") or {}).get("entry") or {}).get("url")]
        urls = [u for u in dict.fromkeys(urls) if u and u != "about:blank"]
        if urls:
            tabs.append({"folderId": tab["groupId"], "urls": urls})

    data = {
        "format": "zen-folder-tools/zen-folders@1",
        "folders": [
            {"id": f["id"], "name": f.get("name") or "Folder", "parentId": f.get("parentId") if f.get("parentId") in ids else None, "collapsed": bool(f.get("collapsed"))}
            for f in folders
        ],
        "tabs": tabs,
    }
    output.write_text(json.dumps(data, indent=1))
    print(f"Exported {len(data['folders'])} folders and {len(tabs)} tabs to {output}")


if __name__ == "__main__":
    main()
