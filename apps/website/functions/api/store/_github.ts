/// <reference types="@cloudflare/workers-types" />

export type GithubEnv = { GITHUB_TOKEN?: string };

type Release = {
  tag_name: string;
  draft: boolean;
  assets: { name: string; download_count: number }[];
};

/** Updater side files: fetched by every install on every check, not downloads. */
const NOT_A_DOWNLOAD = /\.(sig|json|blockmap|txt|sha256)$/i;

/** Downloads of the desktop installers across every app release (v* tags). */
export async function fetchGithubDownloads(env: GithubEnv): Promise<number> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "libretracks-website",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/otonielpv/LibreTracks/releases?per_page=100&page=${page}`,
      { headers },
    );
    if (!response.ok) throw new Error(`github ${response.status}`);
    const releases = (await response.json()) as Release[];
    for (const release of releases) {
      if (release.draft || !release.tag_name.startsWith("v")) continue;
      for (const asset of release.assets) {
        if (!NOT_A_DOWNLOAD.test(asset.name)) total += asset.download_count;
      }
    }
    if (releases.length < 100) break;
  }
  return total;
}
