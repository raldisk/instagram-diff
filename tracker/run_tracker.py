"""
instagram-diff — run_tracker.py
================================
Generate a PDF diff report comparing your Instagram followers/following exports.

Usage:
    python run_tracker.py

Files managed automatically:
    snapshot.csv      <- baseline state (updated only when changes detected)
    history.csv       <- permanent append-only change log
    last_changes.csv  <- last diff retained for idempotent re-runs
"""

import argparse
import csv
import logging
import os
import tempfile
from copy import deepcopy
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from reportlab.graphics.shapes import Circle, Drawing, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

# -- LOGGING ------------------------------------------------------------------
log = logging.getLogger(__name__)

# -- CONFIG -------------------------------------------------------------------
SNAPSHOT_CSV     = "snapshot.csv"
HISTORY_CSV      = "history.csv"
LAST_CHANGES_CSV = "last_changes.csv"
FOLLOWERS_CSV    = "followers.csv"
FOLLOWING_CSV    = "following.csv"
PICS_DIR         = "cache-pfp"
DATE_STR         = datetime.now().strftime("%Y-%m-%d")
OUTPUT_PDF       = f"report_{DATE_STR}.pdf"
AVATAR_SIZE      = 10 * mm

REQUIRED_EXPORT_FIELDS   = {"Username", "Full Name"}
REQUIRED_SNAPSHOT_FIELDS = {"Type", "Username", "Full Name", "Status"}

# -- FONT SETUP (Unicode-safe, cross-platform) --------------------------------
def _setup_font() -> str:
    """
    Attempt to register DejaVuSans for full Unicode support.
    Search order: bundled -> Linux system -> Windows system -> fallback Helvetica.
    """
    candidates = [
        Path(__file__).parent / "DejaVuSans.ttf",                          # bundled in repo
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),            # Linux
        Path(os.environ.get("WINDIR", "")) / "Fonts" / "DejaVuSans.ttf",   # Windows
        Path("/Library/Fonts/DejaVuSans.ttf"),                              # macOS
    ]
    for path in candidates:
        if path.exists():
            try:
                pdfmetrics.registerFont(TTFont("DejaVuSans", str(path)))
                return "DejaVuSans"
            except Exception:
                continue
    return "Helvetica"

BODY_FONT = _setup_font()

# -- ATOMIC WRITE HELPER ------------------------------------------------------
def _atomic_csv_write(path, header, rows):
    """Write to a .tmp file then atomically replace target — prevents partial writes."""
    p = Path(path)
    with tempfile.NamedTemporaryFile(
        "w", delete=False, newline="", encoding="utf-8", dir=p.parent
    ) as tf:
        w = csv.writer(tf)
        w.writerow(header)
        for row in rows:
            w.writerow(row)
    Path(tf.name).replace(p)

# -- COLORS -------------------------------------------------------------------
C_DARK_BLUE    = colors.HexColor("#1F4E79")
C_MID_BLUE     = colors.HexColor("#2E75B6")
C_MUTUAL       = colors.HexColor("#D6E4F0")
C_FOLLOWER     = colors.HexColor("#EAF4FB")
C_FOLLOWING    = colors.HexColor("#FFF9E6")
C_NEW          = colors.HexColor("#C6EFCE")
C_NEW_DARK     = colors.HexColor("#1A6321")
C_REMOVED      = colors.HexColor("#FFCCCC")
C_DEACTIVATED  = colors.HexColor("#FFE0B2")
C_REMOVED_HDR  = colors.HexColor("#9E0000")
C_RETURNED     = colors.HexColor("#E8D5F5")
C_RETURNED_HDR = colors.HexColor("#6A0DAD")
C_WHITE        = colors.white
C_GRAY_TEXT    = colors.HexColor("#555555")

AVATAR_PALETTE = [
    "#1F4E79", "#2E75B6", "#1A6321", "#9E0000",
    "#7B3F00", "#4B0082", "#006400", "#8B0000",
]

# -- CSV VALIDATION -----------------------------------------------------------
def validate_csv(path, required_fields):
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = required_fields - set(reader.fieldnames or [])
        if missing:
            raise ValueError(
                f"CSV '{path}' is missing required columns: {missing}\n"
                f"  Found: {set(reader.fieldnames or [])}"
            )

# -- LOAD / SAVE --------------------------------------------------------------
def load_export(path):
    if not Path(path).exists():
        log.error(f"Missing required file: {path}")
        raise SystemExit(1)
    try:
        validate_csv(path, REQUIRED_EXPORT_FIELDS)
        data = {}
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                data[row["Username"]] = {
                    "full_name":   row["Full Name"],
                    "picture_url": row.get("Picture Url", ""),
                }
        return data
    except PermissionError:
        log.error(f"Permission denied reading {path}")
        raise SystemExit(1)
    except ValueError as e:
        log.error(str(e))
        raise SystemExit(1)

def load_snapshot(path):
    data = {}
    if not os.path.exists(path):
        return data
    try:
        validate_csv(path, REQUIRED_SNAPSHOT_FIELDS)
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                data[row["Username"]] = {
                    "type":      row["Type"],
                    "full_name": row["Full Name"],
                    "status":    row["Status"],
                }
    except PermissionError:
        log.error(f"Permission denied reading {path}")
        raise SystemExit(1)
    except ValueError as e:
        log.error(str(e))
        raise SystemExit(1)
    return data

def save_snapshot(path, all_current, followers, following, status_map):
    try:
        rows = []
        for u in sorted(all_current):
            fn = (followers.get(u) or following.get(u) or {}).get("full_name", "")
            rows.append(["Personal Profile", u, fn, status_map[u]])
        _atomic_csv_write(path, ["Type", "Username", "Full Name", "Status"], rows)
    except PermissionError:
        log.error(f"Permission denied writing {path} - snapshot not updated.")
        raise SystemExit(1)

def load_history(path):
    data = {}
    if not os.path.exists(path):
        return data
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            data.setdefault(row["Username"], []).append(row)
    return data

def append_history(path, events):
    """Append events to history CSV. flush+fsync after write to minimize partial-line corruption."""
    is_new = not os.path.exists(path)
    try:
        with open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if is_new:
                w.writerow(["Date", "Username", "Full Name", "Event", "Old Status", "New Status"])
            for e in events:
                w.writerow([
                    e["date"], e["username"], e["full_name"],
                    e["event"], e["old_status"], e["new_status"],
                ])
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                log.debug("os.fsync unavailable or failed for history file.")
    except PermissionError:
        log.error(f"Permission denied writing {path} - history not updated.")
        raise SystemExit(1)

def save_last_changes(path, new_accounts, returned, removed_accounts,
                       snapshot, followers, following, status_map):
    rows = []
    for u in new_accounts:
        fn = (followers.get(u) or following.get(u) or {}).get("full_name", "")
        rows.append(["New", u, fn, "", status_map.get(u, "")])
    for u in returned:
        fn = (followers.get(u) or following.get(u) or {}).get("full_name", "")
        rows.append(["Returned", u, fn, "Removed", status_map.get(u, "")])
    for u in removed_accounts:
        snap = snapshot.get(u, {})
        rows.append(["Removed", u, snap.get("full_name", ""), snap.get("status", ""), ""])
    _atomic_csv_write(path, ["Category", "Username", "Full Name", "Old Status", "New Status"], rows)

def load_last_changes(path):
    new_accounts, returned, removed_accounts = set(), set(), set()
    if not os.path.exists(path):
        return new_accounts, returned, removed_accounts
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            u = row["Username"]
            if   row["Category"] == "New":      new_accounts.add(u)
            elif row["Category"] == "Returned": returned.add(u)
            elif row["Category"] == "Removed":  removed_accounts.add(u)
    return new_accounts, returned, removed_accounts

# -- STATUS -------------------------------------------------------------------
def build_status_map(all_current, followers, following):
    """Precompute status using set ops — one pass, no repeated membership checks."""
    followers_set = set(followers.keys())
    following_set = set(following.keys())

    mutual       = followers_set & following_set
    follower_only = followers_set - following_set
    following_only = following_set - followers_set

    result = {}
    for u in mutual:        result[u] = "Mutual"
    for u in follower_only: result[u] = "Follower Only"
    for u in following_only: result[u] = "Following Only"
    for u in all_current:   result.setdefault(u, "Following Only")
    return result

# -- CHANGE DETECTION (pure) --------------------------------------------------
def detect_changes(all_current, snapshot, history, status_map):
    """
    Pure diff engine. No I/O, no side effects.
    Returns (new_accounts, returned, removed_accounts, history_events).
    """
    raw_new     = all_current - set(snapshot.keys())
    raw_removed = set(snapshot.keys()) - all_current

    previously_removed = {
        u for u, evts in history.items()
        for e in evts if e["Event"] in ("Removed", "Possibly Deactivated")
    }

    new_accounts = {u for u in raw_new if u not in previously_removed}
    returned     = {u for u in raw_new if u     in previously_removed}

    today  = datetime.now().strftime("%Y-%m-%d %H:%M")
    events = []

    for u in new_accounts:
        events.append({
            "date": today, "username": u, "full_name": "",
            "event": "New", "old_status": "",
            "new_status": status_map.get(u, ""),
        })
    for u in returned:
        events.append({
            "date": today, "username": u, "full_name": "",
            "event": "Returned", "old_status": "Removed",
            "new_status": status_map.get(u, ""),
        })
    for u in raw_removed:
        snap       = snapshot[u]
        old_status = snap["status"]
        event_type = "Possibly Deactivated" if old_status == "Mutual" else "Removed"
        events.append({
            "date": today, "username": u, "full_name": snap["full_name"],
            "event": event_type, "old_status": old_status, "new_status": "",
        })

    return new_accounts, returned, raw_removed, events

# -- AVATAR -------------------------------------------------------------------
def avatar_image(username, size=AVATAR_SIZE):
    pic_path = Path(PICS_DIR) / f"{username}.jpg"
    if pic_path.exists():
        return Image(str(pic_path), width=size, height=size, kind="proportional")
    return _initials_avatar(username, size)

@lru_cache(maxsize=2048)
def _cached_initials_drawing(username: str, px: float):
    """Cached Drawing factory — arguments are hashable. Caller must deepcopy before use."""
    idx = sum(ord(c) for c in username) % len(AVATAR_PALETTE)
    bg  = colors.HexColor(AVATAR_PALETTE[idx])
    d   = Drawing(px, px)
    d.add(Circle(px/2, px/2, px/2, fillColor=bg, strokeColor=None))
    d.add(String(
        px/2, px/2 - 3, username[:2].upper(),
        textAnchor="middle", fontSize=px * 0.35,
        fillColor=colors.white, fontName="Helvetica-Bold",
    ))
    return d

def _initials_avatar(username, size=AVATAR_SIZE):
    px = round(size / mm * 2.835, 4)
    return deepcopy(_cached_initials_drawing(username, px))

# -- STYLES -------------------------------------------------------------------
s_title    = ParagraphStyle("title",   fontSize=22, leading=28, textColor=C_DARK_BLUE,
                             fontName="Helvetica-Bold", alignment=TA_CENTER)
s_subtitle = ParagraphStyle("sub",     fontSize=10, leading=14, textColor=C_GRAY_TEXT,
                             fontName=BODY_FONT, alignment=TA_CENTER)
s_section  = ParagraphStyle("section", fontSize=13, leading=18, textColor=C_WHITE,
                             fontName="Helvetica-Bold", alignment=TA_LEFT, leftIndent=6)
s_note     = ParagraphStyle("note",    fontSize=8,  leading=11, textColor=C_GRAY_TEXT,
                             fontName=BODY_FONT)
s_sum      = ParagraphStyle("summary", fontSize=11, fontName="Helvetica-Bold",
                             alignment=TA_CENTER, textColor=C_WHITE, leading=16)
s_body     = ParagraphStyle("body",    fontSize=8.5, fontName=BODY_FONT,
                             leading=11, textColor=colors.black)

def _section_header(text, bg):
    tbl = Table([[Paragraph(text, s_section)]], colWidths=[170 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,-1), bg),
        ("TOPPADDING",    (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING",   (0,0), (-1,-1), 10),
    ]))
    return tbl

def _make_table(headers, rows, col_widths, row_bgs):
    data = [headers] + rows
    tbl  = Table(data, colWidths=col_widths, repeatRows=1)
    base = [
        ("FONTNAME",      (0,0), (-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,0),  9),
        ("BACKGROUND",    (0,0), (-1,0),  C_DARK_BLUE),
        ("TEXTCOLOR",     (0,0), (-1,0),  C_WHITE),
        ("FONTNAME",      (0,1), (-1,-1), BODY_FONT),
        ("FONTSIZE",      (0,1), (-1,-1), 8.5),
        ("ALIGN",         (0,0), (-1,-1), "LEFT"),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
        ("TOPPADDING",    (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
        ("LEFTPADDING",   (0,0), (-1,-1), 5),
        ("LINEBELOW",     (0,0), (-1,-1), 0.3, colors.HexColor("#CCCCCC")),
    ]
    for ri, bg in enumerate(row_bgs, 1):
        base.append(("BACKGROUND", (0,ri), (-1,ri), bg))
    tbl.setStyle(TableStyle(base))
    return tbl

# -- PAGE NUMBER CALLBACK -----------------------------------------------------
def _add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont(BODY_FONT, 8)
    canvas.setFillColor(C_GRAY_TEXT)
    canvas.drawRightString(A4[0] - 15*mm, 8*mm, f"Page {doc.page}")
    canvas.restoreState()

# -- PDF GENERATION -----------------------------------------------------------
def generate_report(followers, following, snapshot,
                     new_accounts, returned, removed_accounts, status_map):
    all_current = set(followers) | set(following)

    doc = SimpleDocTemplate(
        OUTPUT_PDF, pagesize=A4,
        leftMargin=15*mm, rightMargin=15*mm,
        topMargin=15*mm, bottomMargin=18*mm,
    )
    story = []

    # Title
    story += [
        Spacer(1, 4*mm),
        Paragraph("Instagram Tracker Report", s_title),
        Spacer(1, 2*mm),
        Paragraph(f"Generated: {datetime.now().strftime('%B %d, %Y  %I:%M %p')}", s_subtitle),
        Spacer(1, 3*mm),
        HRFlowable(width="100%", thickness=1.5, color=C_DARK_BLUE),
        Spacer(1, 4*mm),
    ]

    # Summary strip
    mutual_ct = sum(1 for u in all_current if status_map.get(u) == "Mutual")
    sum_data = [[
        Paragraph(f"<b>Mutual</b><br/>{mutual_ct}",              s_sum),
        Paragraph(f"<b>Followers</b><br/>{len(followers)}",      s_sum),
        Paragraph(f"<b>Following</b><br/>{len(following)}",      s_sum),
        Paragraph(f"<b>New</b><br/>{len(new_accounts)}",         s_sum),
        Paragraph(f"<b>Returned</b><br/>{len(returned)}",        s_sum),
        Paragraph(f"<b>Removed</b><br/>{len(removed_accounts)}", s_sum),
    ]]
    sum_tbl = Table(sum_data, colWidths=[28*mm]*6)
    sum_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(0,0), C_DARK_BLUE),
        ("BACKGROUND",    (1,0),(2,0), C_MID_BLUE),
        ("BACKGROUND",    (3,0),(3,0), C_NEW_DARK),
        ("BACKGROUND",    (4,0),(4,0), C_RETURNED_HDR),
        ("BACKGROUND",    (5,0),(5,0), C_REMOVED_HDR),
        ("ALIGN",         (0,0),(-1,-1), "CENTER"),
        ("VALIGN",        (0,0),(-1,-1), "MIDDLE"),
        ("TOPPADDING",    (0,0),(-1,-1), 8),
        ("BOTTOMPADDING", (0,0),(-1,-1), 8),
    ]))
    story += [sum_tbl, Spacer(1, 6*mm)]

    # New accounts
    if new_accounts:
        story += [_section_header(f"New Accounts ({len(new_accounts)})", C_NEW_DARK), Spacer(1,2*mm)]
        rows, bgs = [], []
        for u in sorted(new_accounts, key=str.lower):
            fn = (followers.get(u) or following.get(u) or {}).get("full_name","") or "-"
            rows.append([avatar_image(u), Paragraph(f"@{u}", s_body),
                         Paragraph(fn, s_body), status_map.get(u,"")])
            bgs.append(C_NEW)
        story += [_make_table(["","Username","Full Name","Status"], rows,
                               [13*mm,48*mm,72*mm,28*mm], bgs), Spacer(1,6*mm)]

    # Returned accounts
    if returned:
        story += [_section_header(f"Returned Accounts ({len(returned)})", C_RETURNED_HDR), Spacer(1,2*mm)]
        rows, bgs = [], []
        for u in sorted(returned, key=str.lower):
            fn = (followers.get(u) or following.get(u) or {}).get("full_name","") or "-"
            rows.append([avatar_image(u), Paragraph(f"@{u}", s_body),
                         Paragraph(fn, s_body), status_map.get(u,""), "Reactivated / Re-followed"])
            bgs.append(C_RETURNED)
        story += [_make_table(["","Username","Full Name","Status","Note"], rows,
                               [13*mm,43*mm,50*mm,26*mm,34*mm], bgs), Spacer(1,6*mm)]

    # Removed accounts
    if removed_accounts:
        story += [_section_header(f"Removed Accounts ({len(removed_accounts)})", C_REMOVED_HDR), Spacer(1,2*mm)]
        rows, bgs = [], []
        for u in sorted(removed_accounts, key=str.lower):
            snap       = snapshot.get(u, {})
            old_status = snap.get("status", "")
            if old_status == "Mutual":
                reason, bg = "Possibly Deactivated", C_DEACTIVATED
            elif old_status == "Follower Only":
                reason, bg = "Unfollowed You",       C_REMOVED
            else:
                reason, bg = "Removed by You",       C_REMOVED
            rows.append([avatar_image(u), Paragraph(f"@{u}", s_body),
                         Paragraph(snap.get("full_name","") or "-", s_body), old_status, reason])
            bgs.append(bg)
        story += [_make_table(["","Username","Full Name","Old Status","Possible Reason"], rows,
                               [13*mm,43*mm,50*mm,26*mm,34*mm], bgs), Spacer(1,6*mm)]

    # Current list
    story += [_section_header(f"Current List ({len(all_current)})", C_DARK_BLUE), Spacer(1,2*mm)]
    STATUS_ORDER = {"Mutual": 0, "Follower Only": 1, "Following Only": 2}
    all_sorted = sorted(
        all_current,
        key=lambda u: (STATUS_ORDER.get(status_map.get(u,""), 3), u.lower()),
    )
    rows, bgs = [], []
    for u in all_sorted:
        fn = (followers.get(u) or following.get(u) or {}).get("full_name","") or "-"
        st = status_map.get(u, "")
        if u in new_accounts:
            change, bg = "New",      C_NEW
        elif u in returned:
            change, bg = "Returned", C_RETURNED
        else:
            change = ""
            bg = C_MUTUAL if st == "Mutual" else C_FOLLOWER if st == "Follower Only" else C_FOLLOWING
        rows.append([avatar_image(u), Paragraph(f"@{u}", s_body), Paragraph(fn, s_body), st, change])
        bgs.append(bg)
    story += [_make_table(["","Username","Full Name","Status","Change"], rows,
                           [13*mm,48*mm,62*mm,28*mm,15*mm], bgs)]

    # Footer
    story += [
        Spacer(1, 4*mm),
        HRFlowable(width="100%", thickness=0.5, color=C_GRAY_TEXT),
        Spacer(1, 2*mm),
        Paragraph(
            "Returned: previously removed or deactivated accounts that came back. "
            "Possibly Deactivated: was Mutual and completely disappeared. "
            f"All changes permanently logged in history.csv. Font: {BODY_FONT}.",
            s_note,
        ),
    ]

    doc.build(story, onFirstPage=_add_page_number, onLaterPages=_add_page_number)
    log.info(f"Report saved: {OUTPUT_PDF}")

# -- MAIN ---------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate Instagram diff report")
    parser.add_argument("--followers", default=FOLLOWERS_CSV)
    parser.add_argument("--following", default=FOLLOWING_CSV)
    parser.add_argument("--snapshot", default=SNAPSHOT_CSV)
    parser.add_argument("--history",  default=HISTORY_CSV)
    parser.add_argument("--output",   default=OUTPUT_PDF)
    parser.add_argument("--debug",    action="store_true", help="Enable debug logging")
    parser.add_argument("--no-pdf",   action="store_true", help="Skip PDF generation (dry run)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="  %(message)s",
    )

    # Override globals with CLI args
    FOLLOWERS_CSV    = args.followers
    FOLLOWING_CSV    = args.following
    SNAPSHOT_CSV     = args.snapshot
    HISTORY_CSV      = args.history
    OUTPUT_PDF       = args.output

    log.info("Loading data...")

    followers = load_export(FOLLOWERS_CSV)
    following = load_export(FOLLOWING_CSV)

    all_current = set(followers) | set(following)
    status_map  = build_status_map(all_current, followers, following)

    if not os.path.exists(SNAPSHOT_CSV):
        log.info("No snapshot.csv found - creating baseline...")
        save_snapshot(SNAPSHOT_CSV, all_current, followers, following, status_map)
        log.info(f"snapshot.csv created with {len(all_current)} accounts.")

    snapshot = load_snapshot(SNAPSHOT_CSV)
    history  = load_history(HISTORY_CSV)

    new_accounts, returned, removed_accounts, events = detect_changes(
        all_current, snapshot, history, status_map)

    # Enrich events with full names from current exports
    export_names = {
        u: (followers.get(u) or following.get(u) or {}).get("full_name","")
        for u in all_current
    }
    for e in events:
        if not e["full_name"]:
            e["full_name"] = export_names.get(e["username"], "")

    has_changes = bool(new_accounts or returned or removed_accounts)

    if has_changes:
        log.info("Logging changes to history.csv...")
        append_history(HISTORY_CSV, events)
        save_last_changes(
            LAST_CHANGES_CSV, new_accounts, returned,
            removed_accounts, snapshot, followers, following, status_map,
        )
        log.info("Updating snapshot...")
        save_snapshot(SNAPSHOT_CSV, all_current, followers, following, status_map)
    else:
        new_accounts, returned, removed_accounts = load_last_changes(LAST_CHANGES_CSV)
        log.info("No new changes - retaining last recorded diff.")

    log.info(
        f"Current: {len(all_current)}  |  "
        f"New: {len(new_accounts)}  |  "
        f"Returned: {len(returned)}  |  "
        f"Removed: {len(removed_accounts)}"
    )

    pics_count = len(list(Path(PICS_DIR).glob("*.jpg"))) if Path(PICS_DIR).exists() else 0
    log.info(
        f"Profile pics found: {pics_count} "
        f"({'run download_pics.py to fetch them' if pics_count == 0 else 'will be embedded'})"
    )

    log.info("Generating PDF...")
    if not args.no_pdf:
        generate_report(
            followers, following, snapshot,
            new_accounts, returned, removed_accounts, status_map,
        )
    else:
        log.info("Skipping PDF generation (--no-pdf).")
    log.info("Done!")
