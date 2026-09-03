import edutools._version as version_module
from edutools._version import GitDescription, _local_segment, describe_repo, full_version


def _describe(monkeypatch, stdout: str, returncode: int = 0) -> GitDescription | None:
    """Run describe_repo() against a canned `git describe` result."""
    class _Result:
        def __init__(self) -> None:
            self.stdout = stdout
            self.returncode = returncode

    monkeypatch.setattr(version_module, "_source_checkout", lambda: version_module.Path("/repo"))
    monkeypatch.setattr(version_module.subprocess, "run", lambda *a, **k: _Result())
    return describe_repo()


class TestDescribeRepo:
    def test_returns_none_outside_a_checkout(self, monkeypatch):
        monkeypatch.setattr(version_module, "_source_checkout", lambda: None)
        assert describe_repo() is None

    def test_returns_none_when_git_fails(self, monkeypatch):
        assert _describe(monkeypatch, "", returncode=128) is None

    def test_parses_tagged_commit(self, monkeypatch):
        assert _describe(monkeypatch, "v1.2.3-0-gabc1234\n") == GitDescription(
            tag="v1.2.3", distance=0, commit="abc1234", dirty=False
        )

    def test_parses_distance_and_dirty(self, monkeypatch):
        assert _describe(monkeypatch, "v1.2.3-5-gabc1234-dirty\n") == GitDescription(
            tag="v1.2.3", distance=5, commit="abc1234", dirty=True
        )

    def test_parses_bare_hash_when_no_tags_exist(self, monkeypatch):
        assert _describe(monkeypatch, "abc1234-dirty\n") == GitDescription(
            tag=None, distance=0, commit="abc1234", dirty=True
        )


class TestLocalSegment:
    def test_tagged_and_clean_has_no_segment(self):
        assert _local_segment(GitDescription("v1.2.3", 0, "abc1234", False)) is None

    def test_dirty_tagged_commit_is_marked(self):
        assert _local_segment(GitDescription("v1.2.3", 0, "abc1234", True)) == "0.gabc1234.dirty"

    def test_commits_past_the_tag_are_counted(self):
        assert _local_segment(GitDescription("v1.2.3", 5, "abc1234", False)) == "5.gabc1234"

    def test_untagged_checkout_reports_only_the_commit(self):
        assert _local_segment(GitDescription(None, 0, "abc1234", False)) == "gabc1234"


class TestFullVersion:
    def test_installed_package_reports_the_release_version(self, monkeypatch):
        monkeypatch.setattr(version_module, "release_version", lambda: "1.2.3")
        monkeypatch.setattr(version_module, "describe_repo", lambda: None)
        assert full_version() == "1.2.3"

    def test_source_checkout_is_annotated(self, monkeypatch):
        monkeypatch.setattr(version_module, "release_version", lambda: "1.2.3")
        monkeypatch.setattr(
            version_module, "describe_repo", lambda: GitDescription("v1.2.3", 5, "abc1234", True)
        )
        assert full_version() == "1.2.3+5.gabc1234.dirty"
