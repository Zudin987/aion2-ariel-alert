import unittest
from datetime import datetime, timezone
from unittest.mock import patch
import monitor


def page(*, name="Ariel", faction="Elyos", region="Asia", online="Online", blocked=True):
    icon = '<svg aria-label="Character creation blocked"></svg>' if blocked else ""
    return f"""<html><div title="Oct 8, 2026, 09:19:14 AM UTC">Updated 55 seconds ago</div>
    <div aria-label="Character creation blocked">legend</div>
    <table><thead><tr><th>Status</th><th>Server</th><th>Faction</th><th>Region</th><th>Population</th></tr></thead>
    <tbody><tr><td>{online}</td><td><span class="font-medium">{name}</span>{icon}</td>
    <td>{faction}</td><td>{region}</td><td>50%</td></tr></tbody></table></html>"""


class ParserTests(unittest.TestCase):
    def test_blocked(self):
        self.assertEqual(monitor.parse_status(page())["creation"], "blocked")

    def test_open_ignores_legend_icon(self):
        self.assertEqual(monitor.parse_status(page(blocked=False))["creation"], "open")

    def test_offline_is_unavailable(self):
        self.assertEqual(monitor.parse_status(page(online="Maintenance", blocked=False))["creation"], "unavailable")

    def test_wrong_server_fails_closed(self):
        with self.assertRaises(monitor.UntrustedSource):
            monitor.parse_status(page(name="Siel"))

    def test_wrong_faction_fails_closed(self):
        with self.assertRaises(monitor.UntrustedSource):
            monitor.parse_status(page(faction="Asmodian"))

    def test_duplicate_target_fails_closed(self):
        p = page()
        p = p.replace("</tbody>", '<tr><td>Online</td><td><span class="font-medium">Ariel</span></td><td>Elyos</td><td>Asia</td><td>50%</td></tr></tbody>')
        with self.assertRaises(monitor.UntrustedSource):
            monitor.parse_status(p)

    def test_favorites_column_blocked(self):
        p = page()
        p = p.replace("<th>Status</th>", "<th>Favorites</th><th>Status</th>")
        p = p.replace("<tr><td>Online</td>", "<tr><td>☆</td><td>Online</td>")
        self.assertEqual(monitor.parse_status(p)["creation"], "blocked")

    def test_favorites_column_open(self):
        p = page(blocked=False)
        p = p.replace("<th>Status</th>", "<th>Favorites</th><th>Status</th>")
        p = p.replace("<tr><td>Online</td>", "<tr><td>☆</td><td>Online</td>")
        self.assertEqual(monitor.parse_status(p)["creation"], "open")

    def test_blank_favorites_heading(self):
        p = page()
        p = p.replace("<th>Status</th>", "<th></th><th>Status</th>")
        p = p.replace("<tr><td>Online</td>", "<tr><td>☆</td><td>Online</td>")
        self.assertEqual(monitor.parse_status(p)["creation"], "blocked")

    def test_missing_creation_lock_schema_fails_closed(self):
        p = page(blocked=False).replace("Character creation blocked", "Something else")
        with self.assertRaises(monitor.UntrustedSource):
            monitor.parse_status(p)

    def test_timestamp_is_accepted(self):
        with patch("monitor.datetime") as dt:
            dt.strptime.return_value = datetime(2026, 10, 8, 9, 19, 14)
            dt.now.return_value = datetime(2026, 10, 8, 9, 20, 0, tzinfo=timezone.utc)
            monitor.assert_fresh(page())

    def test_missing_timestamp_fails_closed(self):
        with self.assertRaises(monitor.UntrustedSource):
            monitor.assert_fresh(page().replace('title="Oct 8, 2026, 09:19:14 AM UTC"', ""))


if __name__ == "__main__":
    unittest.main()
