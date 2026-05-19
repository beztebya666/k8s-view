#!/usr/bin/env python3
"""Delete orphaned (untagged) GHCR container versions.

Every multi-arch push leaves the *previous* build's per-arch image
manifests untagged — only the new manifest-list keeps the tag. Those
orphans pile up forever. This prunes them while keeping every manifest
that is still reachable from a live tag (beta / latest / vX.Y.Z),
including the per-arch and attestation children of tagged manifest-lists.

Best-effort by design: any error is logged and the script still exits 0,
because registry housekeeping must never fail a release.

Inputs (environment):
  GHCR_TOKEN   PAT with read:packages + delete:packages   (required)
  GHCR_OWNER   package owner          (default: beztebya666)
  GHCR_PACKAGE container package name (default: k8s-view)
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

OWNER = os.environ.get("GHCR_OWNER", "beztebya666")
PACKAGE = os.environ.get("GHCR_PACKAGE", "k8s-view")
TOKEN = os.environ.get("GHCR_TOKEN", "")

API = "https://api.github.com"
REG = "https://ghcr.io"
MANIFEST_ACCEPT = ",".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def _req(method, url, headers, want_json=True):
    r = urllib.request.Request(url, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=40) as resp:
        body = resp.read()
        return (json.loads(body) if want_json and body else body), resp.headers


def api_headers():
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kv-ghcr-prune",
    }


def list_versions():
    """All container versions, following pagination."""
    out, page = [], 1
    while True:
        url = (f"{API}/user/packages/container/{PACKAGE}/versions"
               f"?per_page=100&page={page}")
        batch, _ = _req("GET", url, api_headers())
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return out


def registry_token():
    """Anonymous-style pull token, authenticated with the PAT via Basic."""
    basic = base64.b64encode(f"{OWNER}:{TOKEN}".encode()).decode()
    url = f"{REG}/token?service=ghcr.io&scope=repository:{OWNER}/{PACKAGE}:pull"
    data, _ = _req("GET", url, {"Authorization": f"Basic {basic}",
                                "User-Agent": "kv-ghcr-prune"})
    return data["token"]


def child_digests(reg_tok, digest):
    """Child manifest digests of a manifest-list / OCI index (empty for a
    plain single-arch image manifest)."""
    try:
        data, _ = _req("GET", f"{REG}/v2/{OWNER}/{PACKAGE}/manifests/{digest}",
                        {"Authorization": f"Bearer {reg_tok}",
                         "Accept": MANIFEST_ACCEPT,
                         "User-Agent": "kv-ghcr-prune"})
    except urllib.error.HTTPError as e:
        print(f"  warn: manifest {digest[:19]} unreadable (HTTP {e.code})")
        return []
    return [m["digest"] for m in data.get("manifests", []) if m.get("digest")]


def main():
    if not TOKEN:
        print("WARN: GHCR_TOKEN not set — skipping prune")
        return
    try:
        versions = list_versions()
    except urllib.error.HTTPError as e:
        print(f"WARN: cannot list versions (HTTP {e.code}) — skipping prune")
        return

    tagged = [v for v in versions
              if v.get("metadata", {}).get("container", {}).get("tags")]
    print(f"{len(versions)} versions, {len(tagged)} tagged "
          f"({', '.join(sorted(t for v in tagged for t in v['metadata']['container']['tags']))})")

    keep = {v["name"] for v in tagged}  # v["name"] is the sha256 digest
    try:
        reg_tok = registry_token()
        for v in tagged:
            for child in child_digests(reg_tok, v["name"]):
                keep.add(child)
    except Exception as e:  # noqa: BLE001 — best-effort, never fail CI
        print(f"WARN: could not resolve children ({e!r}) — refusing to prune")
        return

    deleted = 0
    for v in versions:
        digest = v["name"]
        has_tags = bool(v.get("metadata", {}).get("container", {}).get("tags"))
        if has_tags or digest in keep:
            continue
        try:
            _req("DELETE",
                 f"{API}/user/packages/container/{PACKAGE}/versions/{v['id']}",
                 api_headers(), want_json=False)
            deleted += 1
            print(f"  deleted orphan {digest[:25]}")
        except urllib.error.HTTPError as e:
            print(f"  warn: delete {digest[:19]} failed (HTTP {e.code})")

    print(f"prune done: kept {len(keep)} referenced, deleted {deleted} orphans")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"WARN: prune aborted ({e!r})")
    sys.exit(0)
