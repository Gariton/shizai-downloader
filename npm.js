const npmFetch = require('npm-registry-fetch');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const process = require('process');
const url = require('url');
const { promisify } = require('util');
const mkdirp = require('mkdirp');
const stream = require('stream');
const streamPipeline = promisify(stream.pipeline);
const semver = require('semver');
const cliProgress = require('cli-progress');
const chalk = require('chalk');

const downloadedPackages = new Set();

async function fetchPackageMetadata(name) {
    try {
        const metadata = await npmFetch.json(`/${name}`);
        return metadata;
    } catch (error) {
        console.error(chalk.red(`パッケージ "${name}" のメタデータ取得中にエラーが発生しました。`));
        throw error;
    }
}

async function promptForVersion(name, versions) {
    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'version',
            message: `パッケージ "${name}" のバージョンを選択してください:`,
            choices: versions.reverse(), // 新しいバージョンから表示
        },
    ]);
    return answer.version;
}

async function downloadTarball(name, version) {
    const pkgSpec = `${name}@${version}`;
    if (downloadedPackages.has(pkgSpec)) {
        return;
    }
    downloadedPackages.add(pkgSpec);

    console.log(chalk.green(`\n処理中: ${pkgSpec}...`));

    // パッケージメタデータを取得
    const metadata = await npmFetch.json(`/${name}/${version}`);

    // 依存関係を取得
    const dependencies = metadata.dependencies || {};

    // ターボールをダウンロード
    const tarballUrl = metadata.dist.tarball;
    const tarballName = path.basename(url.parse(tarballUrl).pathname);
    const outputDir = path.join('downloads', 'npm-packages');
    await mkdirp(outputDir);
    const destPath = path.join(outputDir, tarballName);

    if (!fs.existsSync(destPath)) {
        console.log(`ダウンロード中: ${tarballUrl}...`);

        const response = await npmFetch(tarballUrl);

        const totalSize = parseInt(response.headers.get('content-length'), 10);
        let downloadedSize = 0;

        const progressBar = new cliProgress.SingleBar({
            format: '進行状況 [{bar}] {percentage}% | {downloaded}/{total}KB',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
        });

        progressBar.start(totalSize / 1024, 0);

        response.body.on('data', (chunk) => {
            downloadedSize += chunk.length;
            progressBar.update(downloadedSize / 1024);
        });

        await streamPipeline(response.body, fs.createWriteStream(destPath));
        progressBar.stop();

        console.log(chalk.blue(`ダウンロード完了: ${tarballName}`));
    } else {
        console.log(chalk.yellow(`既にダウンロード済み: ${tarballName}`));
    }

    // 依存関係を再帰的に処理
    for (const [depName, depVersionRange] of Object.entries(dependencies)) {
        const depMetadata = await fetchPackageMetadata(depName);
        const versions = Object.keys(depMetadata.versions);

        const maxSatisfying = semver.maxSatisfying(versions, depVersionRange);

        if (maxSatisfying) {
            await downloadTarball(depName, maxSatisfying);
        } else {
            console.warn(chalk.red(`適合するバージョンが見つかりませんでした: ${depName}@${depVersionRange}`));
        }
    }
}

async function promptForPackageName() {
    const answer = await inquirer.prompt([
        {
            type: 'input',
            name: 'packageName',
            message: 'パッケージ名を入力してください (終了するには :q を入力):',
            validate: (input) => {
                if (input.trim() === '') {
                    return 'パッケージ名を入力してください。';
                }
                return true;
            }
        },
    ]);
    return answer.packageName.trim();
}

async function processPackage(packageName) {
    try {
        const metadata = await fetchPackageMetadata(packageName);
        const versions = Object.keys(metadata.versions);

        let selectedVersion;
        if (versions.length > 1) {
            selectedVersion = await promptForVersion(packageName, versions);
        } else {
            selectedVersion = versions[0];
        }

        await downloadTarball(packageName, selectedVersion);

        console.log(chalk.green(`\nパッケージ "${packageName}" のダウンロードが完了しました。`));
    } catch (error) {
        console.error(chalk.red(`パッケージ "${packageName}" の処理中にエラーが発生しました。`));
    }
}

async function main() {
    try {
        let packageNames = process.argv.slice(2);

        while (true) {
            if (packageNames.length === 0) {
                const packageName = await promptForPackageName();

                if (packageName === ':q') {
                    console.log(chalk.green('プログラムを終了します。'));
                    process.exit(0);
                }

                packageNames = packageName.split(/\s+/);
            }

            for (const pkg of packageNames) {
                await processPackage(pkg);
            }

            // パッケージ名リストをクリア
            packageNames = [];

            // 次のパッケージをダウンロードするか確認
            const answer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'continue',
                    message: '他のパッケージをダウンロードしますか?',
                    default: false,
                },
            ]);

            if (answer.continue) {
                // 次のパッケージ名を入力
                continue;
            } else {
                console.log(chalk.green('プログラムを終了します。'));
                break;
            }
        }
    } catch (error) {
        console.error(chalk.red('エラーが発生しました:'), error);
    }
}

main();