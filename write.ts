import { promises as fs } from 'fs';
import * as path from 'path';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as github from '@actions/github';
import Octokit = require('@octokit/rest');
import * as git from './git';
import { Benchmark, BenchmarkResult } from './extract';
import { Config, ToolType } from './config';
import { DEFAULT_INDEX_HTML } from './default_index_html';

export type BenchmarkEntries = { [name: string]: Benchmark[] };
export interface DataJson {
    lastUpdate: number;
    repoUrl: string;
    entries: BenchmarkEntries;
}

export const SCRIPT_PREFIX = 'window.BENCHMARK_DATA = ';

async function loadDataJson(dataPath: string): Promise<DataJson> {
    try {
        const script = await fs.readFile(dataPath, 'utf8');
        const json = script.slice(SCRIPT_PREFIX.length);
        const parsed = JSON.parse(json);
        core.debug(`Loaded data.js at ${dataPath}`);
        return parsed;
    } catch (err) {
        console.log(`Could not find data.js at ${dataPath}. Using empty default: ${err}`);
        return {
            lastUpdate: 0,
            repoUrl: '',
            entries: {},
        };
    }
}

async function storeDataJson(dataPath: string, data: DataJson) {
    const script = SCRIPT_PREFIX + JSON.stringify(data, null, 2);
    await fs.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}

async function addIndexHtmlIfNeeded(dir: string) {
    const indexHtml = path.join(dir, 'index.html');
    try {
        await fs.stat(indexHtml);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtml}`);
        return;
    } catch (_) {
        // Continue
    }

    await fs.writeFile(indexHtml, DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd('add', indexHtml);
    console.log('Created default index.html at', indexHtml);
}

async function pushGitHubPages(token: string, branch: string) {
    try {
        await git.push(token, branch);
        return;
    } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('[remote rejected]')) {
            throw err;
        }
        // Fall through
    }

    core.warning('Auto push failed because remote seemed to be updated after git pull. Retrying...');

    // Retry push after pull with rebasing
    await git.pull(token, branch, '--rebase');
    await git.push(token, branch);

    core.debug('Retrying auto push was successfully done');
}

function biggerIsBetter(tool: ToolType): boolean {
    switch (tool) {
        case 'cargo':
            return false;
        case 'go':
            return false;
        case 'benchmarkjs':
            return true;
        case 'pytest':
            return true;
    }
}

interface Alert {
    current: BenchmarkResult;
    prev: BenchmarkResult;
    ratio: number;
}

function findAlerts(curEntry: Benchmark, prevEntry: Benchmark, threshold: number): Alert[] {
    core.debug(`Comparing current:${curEntry.commit.id} and prev:${prevEntry.commit.id} for alert`);

    const alerts = [];
    for (const current of curEntry.benches) {
        const prev = prevEntry.benches.find(b => b.name === current.name);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${current.name}' is not found in previous benchmarks`);
            continue;
        }

        const ratio = biggerIsBetter(curEntry.tool)
            ? prev.value / current.value // e.g. current=100, prev=200
            : current.value / prev.value; // e.g. current=200, prev=100

        if (ratio > threshold) {
            core.warning(
                `Performance alert! Previous value was ${prev.value} and current value is ${current.value}. Ratio ${ratio} is bigger than threshold ${threshold}`,
            );
            alerts.push({ current, prev, ratio });
        }
    }

    return alerts;
}

function getCurrentRepo() {
    const repo = github.context.payload.repository;
    if (!repo) {
        throw new Error(
            `Repository information is not available in payload: ${JSON.stringify(github.context.payload, null, 2)}`,
        );
    }
    return repo;
}

function buildAlertComment(
    alerts: Alert[],
    benchName: string,
    curEntry: Benchmark,
    prevEntry: Benchmark,
    threshold: number,
    cc: string[],
): string {
    // Do not show benchmark name if it is the default value 'Benchmark'.
    const benchmarkText = benchName === 'Benchmark' ? '' : ` **'${benchName}'**`;
    const title = threshold === 0 ? '# Performance Report' : '# :warning: **Performance Alert** :warning:';
    const lines = [
        title,
        '',
        `Possible performance regression was detected for benchmark${benchmarkText}.`,
        `Benchmark result of this commit is worse than the previous benchmark result exceeding threshold \`${threshold}\`.`,
        '',
        `| Benchmark suite | Current: ${curEntry.commit.id} | Previous: ${prevEntry.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];

    function strOfValue(b: BenchmarkResult): string {
        let s = `\`${b.value}\` ${b.unit}`;
        if (b.range) {
            s += ` (\`${b.range}\`)`;
        }
        return s;
    }

    for (const alert of alerts) {
        const { current, prev, ratio } = alert;
        const line = `| \`${current.name}\` | ${strOfValue(current)} | ${strOfValue(prev)} | \`${ratio}\` |`;
        lines.push(line);
    }

    const repo = getCurrentRepo();
    // eslint-disable-next-line @typescript-eslint/camelcase
    const repoUrl = repo.html_url;
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + github.context.workflow;
    core.debug(`Action URL: ${actionUrl}`);

    // Footer
    lines.push(
        '',
        `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/rhysd/github-action-benchmark).`,
    );

    if (cc.length > 0) {
        lines.push('', `CC: ${cc.join(' ')}`);
    }

    return lines.join('\n');
}

async function leaveComment(commitId: string, body: string, token: string) {
    core.debug('Sending alert comment:\n' + body);

    const repo = getCurrentRepo();
    // eslint-disable-next-line @typescript-eslint/camelcase
    const repoUrl = repo.html_url;
    const client = new Octokit({ auth: token });
    const res = await client.repos.createCommitComment({
        owner: repo.owner.login,
        repo: repo.name,
        // eslint-disable-next-line @typescript-eslint/camelcase
        commit_sha: commitId,
        body,
    });

    const commitUrl = `${repoUrl}/commit/${commitId}`;
    console.log(`Alert comment was sent to ${commitUrl}. Response:`, res.status, res.data);

    return res;
}

async function alert(
    benchName: string,
    curEntry: Benchmark,
    prevEntry: Benchmark,
    threshold: number,
    token: string | undefined,
    shouldComment: boolean,
    shouldFail: boolean,
    ccUsers: string[],
) {
    if (!shouldComment && !shouldFail) {
        core.debug('Alert check was skipped because both comment-on-alert and fail-on-alert were disabled');
        return;
    }

    const alerts = findAlerts(curEntry, prevEntry, threshold);
    if (alerts.length === 0) {
        core.debug('No performance alert found happily');
        return;
    }

    core.debug(`Found ${alerts.length} alerts`);
    const body = buildAlertComment(alerts, benchName, curEntry, prevEntry, threshold, ccUsers);
    let message = body;

    if (shouldComment) {
        if (!token) {
            throw new Error("'comment-on-alert' is set but github-token is not set");
        }
        const res = await leaveComment(curEntry.commit.id, body, token);
        // eslint-disable-next-line @typescript-eslint/camelcase
        const url = res.data.html_url;
        message = body + `\nComment was generated at ${url}`;
    }

    if (shouldFail) {
        core.debug('Mark this workflow as fail since one or more alerts found');
        throw new Error(message);
    }
}

export async function writeBenchmark(bench: Benchmark, config: Config) {
    const {
        name,
        tool,
        ghPagesBranch,
        benchmarkDataDirPath,
        githubToken,
        autoPush,
        skipFetchGhPages,
        commentOnAlert,
        alertThreshold,
        failOnAlert,
        alertCommentCcUsers,
    } = config;
    const dataPath = path.join(benchmarkDataDirPath, 'data.js');

    /* eslint-disable @typescript-eslint/camelcase */
    const htmlUrl = github.context.payload.repository?.html_url ?? '';
    const isPrivateRepo = github.context.payload.repository?.private ?? false;
    /* eslint-enable @typescript-eslint/camelcase */

    await git.cmd('switch', ghPagesBranch);

    try {
        if (!skipFetchGhPages && (!isPrivateRepo || githubToken)) {
            await git.pull(githubToken, ghPagesBranch);
        } else if (isPrivateRepo) {
            core.warning(
                "'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
                    "before generating a commit, please set 'github-token' input to pull GitHub pages branch",
            );
        }

        await io.mkdirP(benchmarkDataDirPath);

        let prevBench: Benchmark | null = null;
        const data = await loadDataJson(dataPath);
        data.lastUpdate = Date.now();
        data.repoUrl = htmlUrl;

        // Add benchmark result
        if (data.entries[name] === undefined) {
            data.entries[name] = [bench];
            core.debug(`No entry found for benchmark '${name}'. Created.`);
        } else {
            const entries = data.entries[name];
            // Get last entry which has different commit ID for alert comment
            for (const e of entries.slice().reverse()) {
                if (e.commit.id !== bench.commit.id) {
                    prevBench = e;
                    break;
                }
            }
            entries.push(bench);
        }

        await storeDataJson(dataPath, data);

        await git.cmd('add', dataPath);

        await addIndexHtmlIfNeeded(benchmarkDataDirPath);

        await git.cmd('commit', '-m', `add ${name} (${tool}) benchmark result for ${bench.commit.id}`);

        if (githubToken && autoPush) {
            await pushGitHubPages(githubToken, ghPagesBranch);
            console.log(
                `Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`,
            );
        } else {
            core.debug(`Auto-push to ${ghPagesBranch} is skipped because it requires both github-token and auto-push`);
        }

        // Put this after `git push` for reducing possibility to get conflict on push. Since sending
        // comment take time due to API call, do it after updating remote branch.
        if (prevBench === null) {
            core.debug('Alert check was skipped because previous benchmark result was not found');
        } else {
            await alert(
                name,
                bench,
                prevBench,
                alertThreshold,
                githubToken,
                commentOnAlert,
                failOnAlert,
                alertCommentCcUsers,
            );
        }
    } finally {
        // `git switch` does not work for backing to detached head
        await git.cmd('checkout', '-');
    }
}
