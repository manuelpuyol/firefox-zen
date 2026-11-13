#!/usr/bin/env python3
"""Convert a Zen Browser session into a Firefox sessionstore.jsonlz4.

Zen Essentials -> Firefox pinned tabs
Zen folders     -> Firefox tab groups (subfolders get a leading space per level)
Zen pinned tabs -> regular tabs inside their group
Zen normal tabs -> regular tabs at the end

Usage: zen_to_firefox_session.py <zen-profile-dir> <output.jsonlz4>
"""

import json
import sys
import time
from pathlib import Path

import lz4.block

MOZLZ4_MAGIC = b"mozLz40\0"
GROUP_COLORS = ["blue", "purple", "cyan", "orange", "yellow", "pink", "green", "red", "gray"]


def read_mozlz4(path):
    data = Path(path).read_bytes()
    if not data.startswith(MOZLZ4_MAGIC):
        raise SystemExit(f"{path} is not a mozlz4 file")
    return json.loads(lz4.block.decompress(data[len(MOZLZ4_MAGIC):]))


def write_mozlz4(path, obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    Path(path).write_bytes(MOZLZ4_MAGIC + lz4.block.compress(raw))


def current_url(tab):
    entries = tab.get("entries") or []
    if not entries:
        return None
    index = min(max(tab.get("index", len(entries)), 1), len(entries))
    return entries[index - 1].get("url")


def clean_tab(tab, pinned, group_id):
    out = {
        k: v
        for k, v in tab.items()
        if not k.startswith(("zen", "_zen")) and k not in ("groupId", "pinned", "hidden", "requestedIndex")
    }
    out["pinned"] = pinned
    out["hidden"] = False
    if group_id:
        out["groupId"] = group_id
    return out


def main(zen_profile, output):
    session = read_mozlz4(Path(zen_profile) / "zen-sessions.jsonlz4")
    folders = {f["id"]: f for f in session.get("folders", [])}

    def flat_name(folder_id):
        # Firefox groups can't nest. A leading space per nesting level marks a
        # subfolder; userChrome.css indents it under the group above it.
        depth = 0
        parent = folders[folder_id].get("parentId")
        while parent in folders:
            depth += 1
            parent = folders[parent].get("parentId")
        return " " * depth + folders[folder_id]["name"]

    real_tabs = [
        t for t in session.get("tabs", [])
        if not t.get("zenIsEmpty") and current_url(t) not in (None, "about:blank")
    ]

    essentials = [clean_tab(t, True, None) for t in real_tabs if t.get("zenEssential")]

    grouped, group_order = {}, []
    loose = []
    for t in real_tabs:
        if t.get("zenEssential"):
            continue
        gid = t.get("groupId")
        if gid in folders:
            if gid not in grouped:
                grouped[gid] = []
                group_order.append(gid)
            grouped[gid].append(clean_tab(t, False, gid))
        else:
            loose.append(clean_tab(t, False, None))

    # Depth-first folder order, so subfolders directly follow their parent.
    folder_rank, children = {}, {}
    for f in session.get("folders", []):
        children.setdefault(f.get("parentId") if f.get("parentId") in folders else None, []).append(f["id"])

    def visit(fid):
        folder_rank[fid] = len(folder_rank)
        for child in children.get(fid, []):
            visit(child)

    for root in children.get(None, []):
        visit(root)
    group_order.sort(key=lambda gid: folder_rank.get(gid, len(folder_rank)))

    groups = []
    tabs = list(essentials)
    for i, gid in enumerate(group_order):
        groups.append({
            "id": gid,
            "name": flat_name(gid),
            "color": GROUP_COLORS[i % len(GROUP_COLORS)],
            "collapsed": bool(folders[gid].get("collapsed")),
            "saveOnWindowClose": True,
        })
        tabs.extend(grouped[gid])
    tabs.extend(loose)

    if not tabs:
        raise SystemExit("No tabs found in the Zen session")

    now = int(time.time() * 1000)
    write_mozlz4(output, {
        "version": ["sessionrestore", 1],
        "windows": [{
            "tabs": tabs,
            "selected": 1,
            "groups": groups,
            "_closedTabs": [],
            "closedGroups": [],
            "sizemode": "normal",
        }],
        "selectedWindow": 1,
        "_closedWindows": [],
        "savedGroups": [],
        "session": {"lastUpdate": now, "startTime": now, "recentCrashes": 0},
        "global": {},
    })

    print(f"Essentials -> pinned tabs: {len(essentials)}")
    for g in groups:
        print(f"Group '{g['name']}': {len(grouped[g['id']])} tabs")
    print(f"Loose tabs: {len(loose)}")
    print(f"Wrote {output}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
