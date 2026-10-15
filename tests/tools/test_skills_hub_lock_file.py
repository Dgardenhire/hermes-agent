"""skills/.hub/lock.json is published atomically, so a concurrent reader never sees a torn file.

The desktop/TUI skill install RPC and the CLI ``hermes skills install/uninstall`` rewrite the same
lock.json from different processes. An in-place rewrite left it empty between truncate and write;
a concurrent ``record_install`` then loaded ``EMPTY`` and saved a lock holding only its own skill,
dropping the provenance of every other hub-installed skill.
"""

from __future__ import annotations

from tests.file_write_observer import observe_file_writes
from tools.skills_hub import HubLockFile, TapsManager


def _seed(lock: HubLockFile, names: list[str]) -> None:
    lock.save({"version": 1, "installed": {
        name: {"source": "github", "identifier": f"o/r/{name}", "install_path": name, "files": ["SKILL.md"]}
        for name in names
    }})


def test_concurrent_record_install_mid_save_keeps_every_installed_skill(tmp_path):
    path = tmp_path / "skills" / ".hub" / "lock.json"
    writer = HubLockFile(path)
    _seed(writer, ["alpha", "beta", "gamma"])
    data = writer.load()
    data["installed"].pop("gamma")
    other_process_ran = []

    def other_process_installs():
        # A second process records an install while the first is mid-save.
        if other_process_ran:
            return
        other_process_ran.append(True)
        HubLockFile(path).record_install(
            name="newskill", source="github", identifier="o/r/newskill", trust_level="community",
            scan_verdict="safe", skill_hash="sha256:0", install_path="newskill", files=["SKILL.md"],
        )

    with observe_file_writes(other_process_installs):
        writer.save(data)

    assert other_process_ran
    # The concurrent writer saw a complete lock (old or new), never an empty one.
    final = sorted(HubLockFile(path).load()["installed"])
    assert final in (["alpha", "beta"], ["alpha", "beta", "gamma", "newskill"])


def test_reader_mid_save_sees_complete_hub_state(tmp_path):
    lock_path = tmp_path / "lock.json"
    taps_path = tmp_path / "taps.json"
    lock = HubLockFile(lock_path)
    taps = TapsManager(taps_path)
    _seed(lock, ["alpha", "beta"])
    taps.save([{"repo": "o/one", "path": "skills/"}])
    seen = []

    with observe_file_writes(lambda: seen.append((sorted(HubLockFile(lock_path).load()["installed"]),
                                                  [t["repo"] for t in TapsManager(taps_path).load()]))):
        lock.record_uninstall("beta")
        taps.add("o/two")

    assert seen
    assert all(installed and repos for installed, repos in seen), seen
    assert sorted(lock.load()["installed"]) == ["alpha"]
    assert [t["repo"] for t in taps.load()] == ["o/one", "o/two"]
