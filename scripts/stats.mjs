/**
 * Rebuilds each <registry>/stats.json: the download_count of every .tmxplug
 * release asset of the plugins in <registry>/index.json, summed per version
 * and per plugin. Termix shows the total in the plugin store.
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { root } from "./lib.mjs";

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

async function github(url) {
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function releases(repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await github(
      `/repos/${repo}/releases?per_page=100&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

function countDownloads(list) {
  const versions = {};
  let total = 0;
  for (const release of list) {
    if (release.draft) continue;
    const version = release.tag_name.replace(/^v/, "");
    const count = release.assets
      .filter((asset) => asset.name.endsWith(".tmxplug"))
      .reduce((sum, asset) => sum + (asset.download_count ?? 0), 0);
    if (count === 0) continue;
    versions[version] = { downloads: count };
    total += count;
  }
  return { downloads: total, versions };
}

async function buildStats(dir, problems) {
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, "index.json"), "utf8"),
  );
  const plugins = {};
  for (const plugin of index.plugins) {
    const repo = plugin.repository?.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)$/,
    )?.[1];
    if (!repo) continue;
    let entry;
    try {
      entry = countDownloads(await releases(repo));
    } catch (error) {
      problems.push(`${plugin.id}: ${error.message}`);
      continue;
    }
    plugins[plugin.id] = entry;
  }
  return plugins;
}

async function main() {
  const problems = [];

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "index.json")));

  for (const dir of dirs) {
    const plugins = await buildStats(dir, problems);
    const file = path.join(dir, "stats.json");
    const { updatedAt, ...before } = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {};
    if (updatedAt && JSON.stringify(before) === JSON.stringify({ plugins })) {
      console.log(`${path.relative(root, file)}: up to date`);
      continue;
    }
    const stats = { updatedAt: new Date().toISOString(), plugins };
    fs.writeFileSync(file, `${JSON.stringify(stats, null, 2)}\n`);
    console.log(
      `${path.relative(root, file)}: ${Object.keys(plugins).length} plugin(s)`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  }
}

await main();
