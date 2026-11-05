#!/usr/bin/env python3
"""Rebuild the generated part of chrome/userChrome.css.

CSS can't count or walk back to a parent group, so we enumerate:
- "+N" tab counts on each tab group
- hiding subfolders (groups whose name starts with spaces) when the folder
  above them is collapsed
- showing subfolders above their parent folder's own tabs
"""

from pathlib import Path

CSS = Path(__file__).parent / "chrome" / "userChrome.css"
MARKER = "/* @generated — do not edit below this line; run generate_css.py */"
MAX_TABS = 99
MAX_SIBLINGS = 12
MAX_DEPTH = 3
MAX_TOP_LEVEL_GROUPS = 40

TABS = '#tabbrowser-tabs[orient="vertical"]'


def counts():
    for n in range(1, MAX_TABS + 1):
        yield (
            f"{TABS} tab-group:has(> .tabbrowser-tab:nth-child({n} of .tabbrowser-tab)"
            f":nth-last-child(1 of .tabbrowser-tab)) > .tab-group-label-container::before "
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


def subfolders_first():
    """Show subfolders above their parent folder's own tabs.

    Firefox requires a group's tabs to come before any other group, so the
    subfolders are moved visually with flex `order`. Tab groups are
    display: contents, so their labels and tabs are all items of one flex
    list; every item gets an order from the top-level folder it follows:
      3k   - folder k's label, and its subfolders
      3k+1 - folder k's own tabs
      3k+2 - loose tabs after folder k
    Rules for later folders come later in the file with equal specificity,
    so the nearest preceding folder wins.
    """
    top = 'tab-group:not([label^=" "])'
    for k in range(1, MAX_TOP_LEVEL_GROUPS + 1):
        g = f"{TABS} #tabbrowser-arrowscrollbox > :nth-child({k} of {top})"
        base = 3 * k
        yield f":where({g} > *, {g} ~ tab-group > *, {g} ~ :not(tab-group)) {{ order: {base}; }}"
        yield f":where({g} > :is(.tabbrowser-tab, tab-split-view-wrapper)) {{ order: {base + 1}; }}"
        yield f":where({g} ~ :not(tab-group)) {{ order: {base + 2}; }}"


def main():
    text = CSS.read_text()
    head = text[: text.index(MARKER) + len(MARKER)]
    body = "\n".join(["", *subfolder_hiding(), "", *subfolders_first(), "", *counts(), ""])
    CSS.write_text(head + "\n" + body)
    print(f"Regenerated {CSS}")


if __name__ == "__main__":
    main()
