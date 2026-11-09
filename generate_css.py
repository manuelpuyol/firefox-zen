#!/usr/bin/env python3
"""Rebuild the generated part of chrome/userChrome.css.

CSS can't count or walk back to a parent group, so we enumerate:
- "+N" tab counts on each tab group
- hiding subfolders (groups whose name starts with spaces) when the folder
  above them is collapsed
"""

from pathlib import Path

CSS = Path(__file__).parent / "chrome" / "userChrome.css"
MARKER = "/* @generated — do not edit below this line; run generate_css.py */"
MAX_TABS = 99
MAX_SIBLINGS = 12
MAX_DEPTH = 3

TABS = '#tabbrowser-tabs[orient="vertical"]'
# Extension-hidden tabs (folder placeholders) don't count.
VISIBLE_TAB = ".tabbrowser-tab:not([hidden])"


def counts():
    for n in range(1, MAX_TABS + 1):
        yield (
            f"{TABS} tab-group:has(> .tabbrowser-tab:nth-child({n} of {VISIBLE_TAB})"
            f":nth-last-child(1 of {VISIBLE_TAB})) > .tab-group-label-container::before "
            f'{{ content: "+{n}"; }}'
        )


def depth_attr(depth):
    return f'[label^="{" " * depth}"]'


def subfolder_hiding():
    selectors = []
    for parent_depth in range(MAX_DEPTH):
        parent = f"tab-group[collapsed]{depth_attr(parent_depth) if parent_depth else ''}"
        if parent_depth < MAX_DEPTH:
            parent += f":not({depth_attr(parent_depth + 1)})"
        child = f"tab-group{depth_attr(parent_depth + 1)}"
        for k in range(1, MAX_SIBLINGS + 1):
            chain = " + ".join([parent] + [child] * k)
            for part in (".tab-group-label-container", ".tabbrowser-tab"):
                selectors.append(f"{TABS} {chain}:not([hasactivetab]) > {part}")
    # Collapse; the transitions in the hand-written section animate it.
    yield ",\n".join(selectors) + """ {
  height: 0 !important;
  min-height: 0 !important;
  padding-block: 0 !important;
  opacity: 0 !important;
  visibility: hidden !important;
}"""


def main():
    text = CSS.read_text()
    head = text[: text.index(MARKER) + len(MARKER)]
    # (Subfolders used to be moved above their parent's tabs with flex `order`
    # rules keyed on :nth-child(k of tab-group…); those crash Firefox 159 when
    # a tooltip opens, so native groups keep Firefox's order.)
    body = "\n".join(["", *subfolder_hiding(), "", *counts(), ""])
    CSS.write_text(head + "\n" + body)
    print(f"Regenerated {CSS}")


if __name__ == "__main__":
    main()
