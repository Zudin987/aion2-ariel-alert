#!/usr/bin/env python3
"""Check whether Ariel / Elyos / Asia allows AION 2 character creation."""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup

URL = "https://aion2.gaming.tools/server-status?region=AS"
STATE_PATH = Path(__file__).with_name("state.json")
TARGET = ("Ariel", "Elyos", "Asia")
LOCK_LABEL = "Character creation blocked"


class UntrustedSource(Exception):
    """Unexpected or stale source data; do not send an unlock alert."""


def parse_status(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    # The site's layout now includes an optional Favorites column before Status.
    # Never assume the target fields are at fixed table positions.
    if LOCK_LABEL not in html:
        raise UntrustedSource("Character-creation indicator/legend missing")
    matches = []
    candidates = []
    required = ("status", "server", "faction", "region", "population")
    for table in soup.select("table"):
        headers = [el.get_text(" ", strip=True).casefold() for el in table.select("thead th")]
        if not all(headers.count(key) == 1 for key in required):
            if any(key in headers for key in ("status", "server", "faction")):
                candidates.append(headers)
            continue
        idx = {key: headers.index(key) for key in required}
        for row in table.select("tbody tr"):
            cells = row.find_all("td", recursive=False)
            if any(pos >= len(cells) for pos in idx.values()):
                continue
            server_cell = cells[idx["server"]]
            name_el = server_cell.select_one("span.font-medium")
            if name_el is None:
                continue
            identity = (name_el.get_text(" ", strip=True),
                        cells[idx["faction"]].get_text(" ", strip=True),
                        cells[idx["region"]].get_text(" ", strip=True))
            if identity != TARGET:
                continue
            online = cells[idx["status"]].get_text(" ", strip=True)
            icons = server_cell.select('[aria-label="Character creation blocked"]')
            if len(icons) > 1:
                raise UntrustedSource("Duplicate character-creation indicators")
            if online == "Online":
                creation = "blocked" if icons else "open"
            else:
                creation = "unavailable"
            matches.append({
                "server": identity[0], "faction": identity[1], "region": identity[2],
                "online": online, "creation": creation,
                "population": cells[idx["population"]].get_text(" ", strip=True)
            })
    if len(matches) != 1:
        raise UntrustedSource(
            f"Expected one Ariel/Elyos/Asia row; found {len(matches)}. "
            f"Candidate table headers: {candidates[:3]}"
        )
    return matches[0]

def assert_fresh(html: str) -> None:
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.find_all(attrs={"title": True}):
        if el.get_text(" ", strip=True).startswith("Updated "):
            try:
                stamp = datetime.strptime(
                    str(el["title"]), "%b %d, %Y, %I:%M:%S %p UTC"
                ).replace(tzinfo=timezone.utc)
            except ValueError as exc:
                raise UntrustedSource("Invalid data-update timestamp") from exc
            age = (datetime.now(timezone.utc) - stamp).total_seconds()
            if not (-300 <= age <= 1800):
                raise UntrustedSource(f"Stale or future data: {age:.0f} seconds old")
            return
    raise UntrustedSource("Missing data-update timestamp")


def fetch_page() -> str:
    request = Request(URL, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ArielCreationMonitor/1.0)",
        "Accept": "text/html", "Cache-Control": "no-cache"
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                if response.status != 200:
                    raise UntrustedSource(f"HTTP {response.status}")
                return response.read(2_000_001).decode("utf-8")
        except (HTTPError, URLError, OSError, UnicodeError):
            if attempt == 2:
                raise
            time.sleep(3)
    raise UntrustedSource("Page unavailable")


def observe() -> dict:
    html = fetch_page()
    assert_fresh(html)
    return parse_status(html)


def prior_status() -> str | None:
    data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    previous = data.get("creation")
    if previous not in (None, "blocked", "open"):
        raise UntrustedSource("Invalid saved state")
    return previous


def save_status(value: str) -> None:
    STATE_PATH.write_text(json.dumps({"creation": value}, indent=2) + "\n", encoding="utf-8")


def send_discord(*, test: bool = False) -> None:
    webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not re.fullmatch(r"https://(?:discord\.com|discordapp\.com)/api/webhooks/\d+/[^/\s]+", webhook):
        raise RuntimeError("Set a valid DISCORD_WEBHOOK_URL GitHub Actions secret first")
    role = os.getenv("DISCORD_ROLE_ID", "").strip()
    if role and not re.fullmatch(r"\d{15,22}", role):
        raise RuntimeError("DISCORD_ROLE_ID must be a numeric Discord role ID")
    mention = f"<@&{role}> " if role else ""
    if test:
        message = f"{mention}🔔 **Ariel monitor test** — Discord notification works."
    else:
        message = (f"{mention}🟢 **Ariel character creation OPEN!**\n"
                   "**AION 2 Global** · Asia · Elyos · Ariel\n"
                   f"Check in game now: {URL}\n"
                   "_Third-party report; please confirm in game._")
    payload = json.dumps({
        "content": message,
        "allowed_mentions": {"parse": [], "roles": [role] if role else []}
    }).encode("utf-8")
    request = Request(webhook, data=payload, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "ArielCreationMonitor/1.0"
    })
    with urlopen(request, timeout=20) as response:
        if response.status not in (200, 204):
            raise RuntimeError(f"Discord replied HTTP {response.status}")


def main() -> None:
    parser = argparse.ArgumentParser()
    flags = parser.add_mutually_exclusive_group()
    flags.add_argument("--check", action="store_true")
    flags.add_argument("--test-alert", action="store_true")
    args = parser.parse_args()

    if args.test_alert:
        send_discord(test=True)
        print("Test message sent")
        return
    current = observe()
    print(json.dumps(current, indent=2))
    if args.check or current["creation"] == "unavailable":
        return
    previous = prior_status()
    if current["creation"] == previous:
        print("No change; no notification")
        return
    if current["creation"] == "open":
        time.sleep(3)
        if observe()["creation"] != "open":
            raise UntrustedSource("Second check did not confirm unlocked")
        send_discord()
        print("Ariel unlocked: Discord notification sent")
    else:
        print("Ariel locked; no notification")
    save_status(current["creation"])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
