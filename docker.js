// download-docker.js

const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const process = require('process');
const mkdirp = require('mkdirp');
const cliProgress = require('cli-progress');
const chalk = require('chalk');
const axios = require('axios');
const tar = require('tar-stream');

async function downloadDockerImage(imageName) {
    console.log(chalk.green(`\nDockerイメージ "${imageName}" をダウンロードしています...`));

    const outputDir = path.join('downloads', 'docker-images');
    await mkdirp(outputDir);

    let [name, tag] = imageName.split(':');

    // 名前にレジストリが含まれていない場合、デフォルトのDocker Hubを使用
    if (!name.includes('/')) {
        name = `library/${name}`;
    }

    // タグが指定されていない場合、タグの一覧を取得してユーザーに選択してもらう
    if (!tag) {
        tag = await selectTag(name);
    }

    // ファイル名にタグを含める
    const sanitizedImageName = name.replace(/\//g, '_');
    const destFileName = `${sanitizedImageName}_${tag}.tar`; // ファイル名にタグを含める
    const destPath = path.join(outputDir, destFileName);

    if (fs.existsSync(destPath)) {
        console.log(chalk.yellow(`既にダウンロード済み: ${destPath}`));
        return;
    }

    try {
        // デフォルトのDockerレジストリを使用
        const registry = 'registry-1.docker.io';

        // 認証トークンを取得
        const authResponse = await axios.get(`https://auth.docker.io/token`, {
            params: {
                service: 'registry.docker.io',
                scope: `repository:${name}:pull`
            }
        });
        const token = authResponse.data.token;

        // マニフェストを取得
        let manifestResponse = await axios.get(`https://${registry}/v2/${name}/manifests/${tag}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': [
                    'application/vnd.oci.image.index.v1+json',
                    'application/vnd.docker.distribution.manifest.list.v2+json',
                    'application/vnd.oci.image.manifest.v1+json',
                    'application/vnd.docker.distribution.manifest.v2+json',
                    'application/vnd.docker.container.image.v1+json',
                    'application/json'
                ].join(', ')
            }
        });

        let manifest = manifestResponse.data;
        let mediaType = manifest.mediaType || manifestResponse.headers['content-type'];

        // マニフェストの種類を確認
        if (mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json' || mediaType === 'application/vnd.oci.image.index.v1+json') {
            // マニフェストリストまたはOCIインデックスの場合、プラットフォームを選択
            const manifests = manifest.manifests;
            const choices = manifests.map((m, index) => {
                const os = m.platform.os;
                const architecture = m.platform.architecture;
                const variant = m.platform.variant ? ` (${m.platform.variant})` : '';
                return {
                    name: `${os}/${architecture}${variant}`,
                    value: index
                };
            });

            const answer = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedManifestIndex',
                    message: 'プラットフォームを選択してください:',
                    choices: choices
                }
            ]);

            const selectedManifest = manifests[answer.selectedManifestIndex];
            const digest = selectedManifest.digest;

            // 選択したプラットフォームのマニフェストを取得
            manifestResponse = await axios.get(`https://${registry}/v2/${name}/manifests/${digest}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': [
                        'application/vnd.oci.image.manifest.v1+json',
                        'application/vnd.docker.distribution.manifest.v2+json',
                        'application/vnd.docker.container.image.v1+json',
                        'application/json'
                    ].join(', ')
                }
            });

            manifest = manifestResponse.data;
            mediaType = manifest.mediaType || manifestResponse.headers['content-type'];
        }

        if (mediaType === 'application/vnd.oci.image.manifest.v1+json' || mediaType === 'application/vnd.docker.distribution.manifest.v2+json') {
            // レイヤーをダウンロード
            const layers = manifest.layers;
            const totalLayers = layers.length;
            let downloadedLayers = 0;

            const progressBar = new cliProgress.SingleBar({
                format: 'レイヤーのダウンロード [{bar}] {percentage}% | {downloaded}/{total} レイヤー',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true
            });
            progressBar.start(totalLayers, 0, {
                downloaded: downloadedLayers,
                total: totalLayers
            });

            const pack = tar.pack(); // tarファイルを作成

            const tarStream = fs.createWriteStream(destPath);
            pack.pipe(tarStream);

            for (const layer of layers) {
                try {
                    const layerResponse = await axios.get(`https://${registry}/v2/${name}/blobs/${layer.digest}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        },
                        responseType: 'stream'
                    });
    
                    pack.entry({ name: `layer-${layer.digest.replace(/[:/]/g, '_')}.tar.gz` }, layerResponse.data);
                    downloadedLayers++;
                    progressBar.update(downloadedLayers, {
                        downloaded: downloadedLayers,
                        total: totalLayers
                    });
                } catch (error) {
                    console.log("*********************************************************************");
                    console.log("ブラウザで下記urlへbearerをつけてアクセスしてください");
                    console.log(`https://${registry}/v2/${name}/blobs/${layer.digest}`);
                    console.log(`Bearer ${token}`);
                    console.log("*********************************************************************");
                }
            }

            // コンフィグを保存
            const configResponse = await axios.get(`https://${registry}/v2/${name}/blobs/${manifest.config.digest}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                responseType: 'stream'
            });

            pack.entry({ name: 'config.json' }, configResponse.data);

            pack.finalize();
            progressBar.stop();

            console.log(chalk.blue(`Dockerイメージのダウンロードが完了しました: ${destPath}`));
        } else {
            console.error(chalk.red('サポートされていないマニフェストの種類です。'));
            return;
        }
    } catch (error) {
        console.error(chalk.red(`Dockerイメージ "${imageName}" のダウンロード中にエラーが発生しました。`));
        console.error(error.message);
    }
}

async function selectTag(name) {
    try {
        // 認証トークンを取得
        const authResponse = await axios.get(`https://auth.docker.io/token`, {
            params: {
                service: 'registry.docker.io',
                scope: `repository:${name}:pull`
            }
        });
        const token = authResponse.data.token;

        // タグ一覧を取得
        const tagsResponse = await axios.get(`https://registry-1.docker.io/v2/${name}/tags/list`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const tags = tagsResponse.data.tags;

        if (!tags || tags.length === 0) {
            console.error(chalk.red('利用可能なタグが見つかりませんでした。'));
            process.exit(1);
        }

        // タグ一覧をソート（最新順に並べ替え）
        tags.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        const answer = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedTag',
                message: 'タグを選択してください:',
                choices: tags.reverse() // 最新のタグを上に表示
            }
        ]);

        return answer.selectedTag;

    } catch (error) {
        console.error(chalk.red(`タグの取得中にエラーが発生しました: ${error.message}`));
        process.exit(1);
    }
}

async function promptForImageName() {
    const answer = await inquirer.prompt([
        {
            type: 'input',
            name: 'imageName',
            message: 'Dockerイメージ名を入力してください (終了するには :q を入力):',
            validate: (input) => {
                if (input.trim() === '') {
                    return 'Dockerイメージ名を入力してください。';
                }
                return true;
            }
        },
    ]);
    return answer.imageName.trim();
}

async function main() {
    try {
        let imageNames = process.argv.slice(2);

        while (true) {
            if (imageNames.length === 0) {
                const inputName = await promptForImageName();

                if (inputName === ':q') {
                    console.log(chalk.green('プログラムを終了します。'));
                    process.exit(0);
                }

                imageNames = inputName.split(/\s+/);
            }

            for (const name of imageNames) {
                await downloadDockerImage(name);
            }

            // 名前のリストをクリア
            imageNames = [];

            // 次のDockerイメージをダウンロードするか確認
            const answer = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'continue',
                    message: '他のDockerイメージをダウンロードしますか?',
                    default: false,
                },
            ]);

            if (answer.continue) {
                // 次の名前を入力
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