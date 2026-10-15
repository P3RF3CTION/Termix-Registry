/**
 * Rebuilds each <registry>/index.json.
 *
 * A registry with a sources.json (official) lists every release of the
 * repos in it:
 * - a release counts once it has <id>-<version>.tmxplug and its .sig, the
 *   signature matches keys/<registry>.pub, and the packed manifest matches
 *   the tag
 * - a version whose file changed (a re-released version) is replaced
 * - a version whose release is gone is dropped
 *
 * A registry with a plugins/ folder (community) lists only the versions
 * pinned in plugins/<id>.json, which a person reviewed before merging:
 * - the release's .tmxplug must still have the pinned sha256
 * - the registry signs it with TERMIX_<REGISTRY>_SIGNING_KEY (for example
 *   TERMIX_COMMUNITY_SIGNING_KEY) and keeps that signature on later runs
 * - a plugin whose file is removed is dropped
 *
 * In both, betas (semver prerelease versions) go in prereleases, and only
 * while they are newer than the newest stable.
 *
 * A plugin whose release files all still have the sha256 the index lists
 * (read from the GitHub API digest) is kept as listed without downloading,
 * because every download adds to the count the plugin store shows. Pass
 * --full to download and re-read everything anyway.
 *
 * Official plugins take their demo video link from the manifest on their
 * default branch, so a new video shows up without a release.
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assetSha256,
  compareVersions,
  download,
  github,
  githubRepo,
  inspectArtifact,
  isPrerelease,
  isSigned,
  keysFor,
  listing,
  loadKeys,
  loadPrivateKey,
  readSubmissions,
  root,
  sha256,
  signDigest,
  splitChannels,
  versionEntry,
} from "./lib.mjs";

const full = process.argv.includes("--full");

/**
 * The listed plugin when every file it lists is still on GitHub with the same
 * sha256 and nothing new was released, or null when it needs a full read.
 * files is [{ version, asset }] for each release that has a .tmxplug.
 */
function unchanged(old, repository, files, keys) {
  if (full || !old || old.repository !== repository) return null;
  const listed = [...old.versions, ...(old.prereleases ?? [])];
  const newestStable = old.versions[0]?.version;
  let matched = 0;
  for (const { version, asset } of files) {
    const entry = listed.find((item) => item.version === version);
    if (!entry) {
      // A beta that stable has passed is left out of the index on purpose.
      if (
        isPrerelease(version) &&
        newestStable &&
        compareVersions(version, newestStable) <= 0
      ) {
        continue;
      }
      return null;
    }
    const sha = assetSha256(asset);
    if (!sha || sha !== entry.sha256) return null;
    if (!isSigned(Buffer.from(sha, "hex"), entry.signature, keys)) return null;
    matched++;
  }
  return matched === listed.length ? old : null;
}

async function readRelease(repo, release, keys, problems) {
  const where = `${repo}@${release.tag_name}`;
  const artifact = release.assets.find((asset) =>
    asset.name.endsWith(".tmxplug"),
  );
  const sigAsset =
    artifact &&
    release.assets.find((asset) => asset.name === `${artifact.name}.sig`);
  if (!artifact || !sigAsset) return null;

  const buffer = await download(artifact.browser_download_url);
  const signature = (await download(sigAsset.browser_download_url))
    .toString("utf8")
    .trim();
  const digest = sha256(buffer);
  if (!isSigned(digest, signature, keys)) {
    problems.push(`${where}: signature does not match the registry key`);
    return null;
  }

  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") {
    problems.push(`${where}: ${inspected}`);
    return null;
  }
  return {
    manifest: inspected.manifest,
    version: versionEntry({
      ...inspected,
      release,
      artifact,
      buffer,
      digest,
      signature,
    }),
  };
}

/** Keeps the listed copy of an unchanged version, with fresh notes. */
function keep(list, entries) {
  return entries.map(({ version }) => {
    const kept = list?.find(
      (entry) =>
        entry.version === version.version && entry.sha256 === version.sha256,
    );
    if (!kept) return version;
    const { notes, ...rest } = kept;
    return version.notes ? { ...rest, notes: version.notes } : rest;
  });
}

async function officialPlugins(dir, previous, keys, problems) {
  const sources = JSON.parse(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
  );
  const plugins = [];
  const byRepository = new Map(
    [...previous.values()].map((plugin) => [plugin.repository, plugin]),
  );
  for (const repo of sources.repositories) {
    const releases = await github(`/repos/${repo}/releases?per_page=100`);
    const repository = `https://github.com/${repo}`;
    const files = [];
    for (const release of releases) {
      if (release.draft) continue;
      const asset = release.assets.find((item) =>
        item.name.endsWith(".tmxplug"),
      );
      if (asset)
        files.push({ version: release.tag_name.replace(/^v/, ""), asset });
    }
    const kept = unchanged(
      byRepository.get(repository),
      repository,
      files,
      keys,
    );
    if (kept) {
      plugins.push(await withMainVideo(kept, repo, problems));
      continue;
    }

    const found = [];
    for (const release of releases) {
      if (release.draft) continue;
      const entry = await readRelease(repo, release, keys, problems);
      if (entry) found.push(entry);
    }
    if (found.length === 0) continue;

    const { stable, betas } = splitChannels(found);
    // Listing text follows stable, so a beta can't change what stable users see.
    const latest = (stable[0] ?? found[0]).manifest;
    if (found.some(({ manifest }) => manifest.id !== latest.id)) {
      problems.push(`${repo}: releases use more than one plugin id`);
      continue;
    }

    const old = previous.get(latest.id);
    const versions = keep(old?.versions, stable);
    const prereleases = keep(old?.prereleases, betas);
    plugins.push(
      await withMainVideo(
        {
          ...listing(latest, repository, sources.docsBase),
          versions,
          ...(prereleases.length > 0 ? { prereleases } : {}),
        },
        repo,
        problems,
      ),
    );
  }
  return plugins;
}

const YOUTUBE =
  /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}/;

/**
 * Official plugins take their demo video link from the manifest on their
 * default branch, so a new video shows up without a release. Community
 * plugins keep the link from their reviewed release.
 */
async function withMainVideo(entry, repo, problems) {
  try {
    const file = await github(`/repos/${repo}/contents/manifest.json`);
    const manifest = JSON.parse(Buffer.from(file.content, "base64").toString());
    if (typeof manifest.video === "string" && YOUTUBE.test(manifest.video)) {
      return { ...entry, video: manifest.video };
    }
  } catch (error) {
    problems.push(
      `${repo}: could not read the manifest video (${error.message})`,
    );
  }
  return entry;
}

async function readPinned({ repo, id, pin, keys, signer, old, problems }) {
  const where = `${id}@${pin.version}`;
  const release = await github(`/repos/${repo}/releases/tags/v${pin.version}`);
  const artifact = release.assets.find(
    (asset) => asset.name === `${id}-${pin.version}.tmxplug`,
  );
  if (!artifact) {
    problems.push(`${where}: the release has no ${id}-${pin.version}.tmxplug`);
    return null;
  }
  const buffer = await download(artifact.browser_download_url);
  const digest = sha256(buffer);
  if (digest.toString("hex") !== pin.sha256) {
    problems.push(`${where}: the file no longer has the reviewed sha256`);
    return null;
  }
  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") {
    problems.push(`${where}: ${inspected}`);
    return null;
  }
  if (inspected.manifest.id !== id) {
    problems.push(`${where}: the manifest id is ${inspected.manifest.id}`);
    return null;
  }

  const listed = [...(old?.versions ?? []), ...(old?.prereleases ?? [])].find(
    (entry) => entry.version === pin.version && entry.sha256 === pin.sha256,
  );
  let signature = listed?.signature;
  if (!signature || !isSigned(digest, signature, keys)) {
    if (!signer) {
      problems.push(`${where}: no signing key set to sign it with`);
      return null;
    }
    signature = signDigest(digest, signer);
  }
  return {
    manifest: inspected.manifest,
    version: versionEntry({
      ...inspected,
      release,
      artifact,
      buffer,
      digest,
      signature,
    }),
  };
}

/** Like unchanged(), for a reviewed submission whose pins all still match. */
async function keptSubmission(old, repo, submission, pins, keys) {
  if (full || !old) return null;
  const listed = [...old.versions, ...(old.prereleases ?? [])];
  if (
    pins.some((pin) => !listed.some((entry) => entry.sha256 === pin.sha256))
  ) {
    return null;
  }
  const files = [];
  for (const pin of pins) {
    const release = await github(
      `/repos/${repo}/releases/tags/v${pin.version}`,
    ).catch(() => null);
    const asset = release?.assets.find(
      (item) => item.name === `${submission.id}-${pin.version}.tmxplug`,
    );
    if (!asset) return null;
    files.push({ version: pin.version, asset });
  }
  return unchanged(old, `https://github.com/${repo}`, files, keys);
}

async function reviewedPlugins(dir, registry, previous, keys, problems) {
  const envName = `TERMIX_${registry.toUpperCase().replace(/-/g, "_")}_SIGNING_KEY`;
  const signer = loadPrivateKey(process.env[envName]);
  const plugins = [];
  for (const { file, submission } of readSubmissions(dir)) {
    const repo = githubRepo(submission.repository);
    if (!repo) {
      problems.push(`${path.basename(file)}: repository is not a GitHub repo`);
      continue;
    }
    const old = previous.get(submission.id);
    const pins = submission.versions ?? [];
    const kept = await keptSubmission(old, repo, submission, pins, keys);
    if (kept) {
      plugins.push(kept);
      continue;
    }

    const found = [];
    for (const pin of pins) {
      try {
        const entry = await readPinned({
          repo,
          id: submission.id,
          pin,
          keys,
          signer,
          old,
          problems,
        });
        if (entry) found.push(entry);
      } catch (error) {
        problems.push(`${submission.id}@${pin.version}: ${error.message}`);
      }
    }
    if (found.length === 0) continue;

    const { stable, betas } = splitChannels(found);
    const latest = (stable[0] ?? found[0]).manifest;
    const prereleases = betas.map(({ version }) => version);
    plugins.push({
      ...listing(latest, `https://github.com/${repo}`, null),
      versions: stable.map(({ version }) => version),
      ...(prereleases.length > 0 ? { prereleases } : {}),
    });
  }
  return plugins;
}

async function syncRegistry(dir, allKeys, problems) {
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const keys = keysFor(allKeys, index.registry);
  if (keys.length === 0) {
    problems.push(`keys/${index.registry}.pub is missing`);
    return;
  }
  const before = JSON.stringify(index.plugins);
  const previous = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));

  const plugins = fs.existsSync(path.join(dir, "sources.json"))
    ? await officialPlugins(dir, previous, keys, problems)
    : await reviewedPlugins(dir, index.registry, previous, keys, problems);

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) problems.push(`${plugin.id} comes from two repos`);
    ids.add(plugin.id);
  }

  const publicKey = keys[0].publicKey;
  if (JSON.stringify(plugins) === before && index.publicKey === publicKey) {
    console.log(`${path.relative(root, indexPath)}: up to date`);
    return;
  }
  const { $schema, registry, name, apiVersion } = index;
  const next = {
    $schema,
    registry,
    name,
    apiVersion,
    publicKey,
    updatedAt: new Date().toISOString(),
    plugins,
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `${path.relative(root, indexPath)}: ${plugins.length} plugin(s) written`,
  );
}

async function main() {
  const keys = loadKeys();
  const problems = [];

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name))
    .filter(
      (dir) =>
        fs.existsSync(path.join(dir, "index.json")) &&
        (fs.existsSync(path.join(dir, "sources.json")) ||
          fs.existsSync(path.join(dir, "plugins"))),
    );

  for (const dir of dirs) await syncRegistry(dir, keys, problems);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

await main();
