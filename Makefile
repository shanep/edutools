VENV ?= .venv

# Release settings: "make release" bumps BUMP, or set VERSION=x.y.z for an exact version.
BUMP ?= patch
VERSION ?=

.PHONY: bootstrap install lint fmt typecheck test clean help version release release-check

help:
	@echo "Makefile commands:"
	@echo "  bootstrap   - Check uv installation and sync dependencies"
	@echo "  install     - Install the package in editable mode"
	@echo "  lint        - Lint the code using ruff"
	@echo "  fmt         - Format the code using ruff"
	@echo "  typecheck   - Type check the code using pyright"
	@echo "  test        - Run tests using pytest"
	@echo "  clean       - Clean up build artifacts and caches"
	@echo "  version     - Show the released version and the version of this checkout"
	@echo "  release     - Bump the version, commit, tag vX.Y.Z, and push (BUMP=patch|minor|major or VERSION=x.y.z)"

bootstrap:
	@echo "check the uv installation..."
	@if ! command -v uv >/dev/null 2>&1; then \
	  echo "uv not found."; \
	  echo "Check https://github.com/astral-sh/uv for installation instructions."; \
	  exit 1; \
	else \
	  echo "uv is installed: $$(uv --version)"; \
	fi
	@echo "Syncing dependencies using uv..."
	@uv sync

lint:
	uv run ruff check .

fmt:
	uv run ruff format .

typecheck:
	uv run pyright src tests

test:
	uv run pytest

install:
	uv tool install . -e

build:
	uv build

version:
	@printf 'release:  %s\n' "$$(uv version --short)"
	@printf 'checkout: %s\n' "$$(uv run python -c 'from edutools import full_version; print(full_version())')"

# Refuse to cut a release from a checkout that would produce a misleading tag.
release-check:
	@if ! git rev-parse --git-dir >/dev/null 2>&1; then \
	  echo "Not a git repository."; exit 1; \
	fi
	@if ! git symbolic-ref -q HEAD >/dev/null; then \
	  echo "HEAD is detached; check out a branch before releasing."; exit 1; \
	fi
	@if ! git diff --quiet || ! git diff --cached --quiet; then \
	  echo "Working tree has uncommitted changes; commit or stash them first."; exit 1; \
	fi

# Version lives in pyproject.toml; the git tag follows it.
release: release-check test
	@set -e; \
	if [ -n "$(VERSION)" ]; then \
	  uv version "$(VERSION)" >/dev/null; \
	else \
	  uv version --bump $(BUMP) >/dev/null; \
	fi; \
	v="$$(uv version --short)"; \
	if git rev-parse -q --verify "refs/tags/v$$v" >/dev/null; then \
	  echo "Tag v$$v already exists; aborting."; \
	  git checkout -- pyproject.toml uv.lock; \
	  exit 1; \
	fi; \
	git add pyproject.toml uv.lock; \
	git commit -m "Release v$$v"; \
	git tag -a "v$$v" -m "edutools v$$v"; \
	git push --follow-tags; \
	echo "Released v$$v"

clean:
	uv cache clean
	rm -rf $(VENV)
	rm -rf *.egg-info
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type d -name ".ruff_cache" -exec rm -rf {} +
	find . -type d -name ".uv" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +
