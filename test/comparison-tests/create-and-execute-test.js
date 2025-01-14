const assert = require("assert")
const fs = require('fs-extra');
const path = require('path');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const webpack = require('webpack');
// @ts-ignore
const webpackVersion = require('webpack/package.json').version;
const regexEscape = require('escape-string-regexp');
const typescript = require('typescript');
const semver = require('semver');
const glob = require('glob');
const pathExists = require('../pathExists');
const aliasLoader = require('../aliasLoader');
const copySync = require('./copySync');

const saveOutputMode = process.argv.indexOf('--save-output') !== -1;

const indexOfTestToRun = process.argv.indexOf('--test-to-run');
const testToRun = process.argv[indexOfTestToRun + 1];

const indexOfExtraOption = process.argv.indexOf('--extra-option');
const extraOption = indexOfExtraOption === -1 ? undefined : process.argv[indexOfExtraOption + 1];

/** @type {{ [testName: string]: { regular?: {}; transpiled?: {}; } }} */
const savedOutputs = {};

if (saveOutputMode) {
    console.log('Will save output as --save-output was supplied...');
}

const typescriptVersion = semver.major(typescript.version) + '.' + semver.minor(typescript.version);
const FLAKY = '_FLAKY_';
const IGNORE = '_IGNORE_';

// set up new paths
const rootPath = path.resolve(__dirname, '../../');
const rootPathWithIncorrectWindowsSeparator = rootPath.replace(/\\/g, '/');
const stagingPath = path.resolve(rootPath, '.test');

const testPath = path.join(__dirname, testToRun);
const testIsFlaky = pathExists(path.join(testPath, FLAKY));
const testIsIgnored = pathExists(path.join(testPath, IGNORE));

if (testIsIgnored) {
    console.log(testPath + ' is ignored... Not running test.');
}

if (fs.statSync(testPath).isDirectory() &&
    testToRun !== 'testLib' &&
    !testIsIgnored) {

    // @ts-ignore
    describe(`${testToRun}${extraOption ? ` - ${extraOption}: true` : ''}`, function () {
        // @ts-ignore
        it('should have the correct output', createTest(testToRun, testPath, {}));

        if (testToRun === 'declarationOutput' ||
            testToRun === 'declarationOutputWithMaps' ||
            testToRun === 'importsWatch' ||
            testToRun === 'declarationWatch' ||
            testToRun === 'issue71' ||
            testToRun === 'appendSuffixToWatch') { return; }

        // @ts-ignore
        it('should work with transpileOnly', createTest(testToRun, testPath, { transpileOnly: true }));
    });
}


/**
 * Create a Jasmine test
 * @param {string} test 
 * @param {string} testPath 
 * @param {any} options 
 */
function createTest(test, testPath, options) {
    return function (done) {
        this.timeout(60000); // sometimes it just takes awhile
        const testState = createTestState();
        const paths = createPaths(stagingPath, test, options);
        const outputs = {
            regularSavedOutput: undefined,
            transpiledSavedOutput: undefined,
            currentSavedOutput: undefined
        };

        storeSavedOutputs(saveOutputMode, outputs, test, options, paths);

        // copy all input to a staging area
        mkdirp.sync(paths.testStagingPath);
        copySync(testPath, paths.testStagingPath);
        if (test === "projectReferencesWatchRefWithTwoFilesAlreadyBuilt") {
            // Copy output
            copySync(path.resolve(testPath, "libOutput"), path.resolve(paths.testStagingPath, "lib"));
            // Change the buildinfo to use typescript version we have
            const buildInfoPath = path.resolve(paths.testStagingPath, "lib/tsconfig.tsbuildinfo");
            fs.writeFileSync(buildInfoPath, fs.readFileSync(buildInfoPath, "utf8").replace("FakeTSVersion", typescript.version));
        }

        // ensure output directories
        mkdirp.sync(paths.actualOutput);
        mkdirp.sync(paths.webpackOutput);

        // execute webpack
        testState.watcher = webpack(
            createWebpackConfig(paths, options)
        ).watch({ aggregateTimeout: 1500 }, createWebpackWatchHandler(done, paths, testState, outputs, options, test));
    };
}

function createTestState() {
    return {
        doneHasBeenCalled: false,
        iteration: 0,
        lastHash: undefined,
        watcher: undefined
    };
}

function createPaths(stagingPath, test, options) {
    const testStagingPath = path.join(stagingPath, test + (options.transpileOnly ? '.transpile' : ''));
    rimraf.sync(testStagingPath); // Make sure it's clean

    return {
        testStagingPath: testStagingPath,
        actualOutput: path.join(testStagingPath, 'actualOutput'),
        expectedOutput: path.join(testStagingPath, 'expectedOutput-' + typescriptVersion),
        webpackOutput: path.join(testStagingPath, '.output'),
        originalExpectedOutput: path.join(testPath, 'expectedOutput-' + typescriptVersion)
    };
}

/**
 * 
 * @param {boolean} saveOutputMode 
 * @param {{ regularSavedOutput: {}; transpiledSavedOutput: {}; currentSavedOutput: {};}} outputs 
 * @param {*} test 
 * @param {*} options 
 * @param {{ testStagingPath: string; actualOutput: string; expectedOutput: string; webpackOutput: string; originalExpectedOutput: string;}} paths 
 */
function storeSavedOutputs(saveOutputMode, outputs, test, options, paths) {
    if (saveOutputMode) {
        savedOutputs[test] = savedOutputs[test] || {};

        outputs.regularSavedOutput    = savedOutputs[test].regular    = savedOutputs[test].regular    || {};
        outputs.transpiledSavedOutput = savedOutputs[test].transpiled = savedOutputs[test].transpiled || {};
        outputs.currentSavedOutput    = options.transpileOnly ? outputs.transpiledSavedOutput : outputs.regularSavedOutput;

        mkdirp.sync(paths.originalExpectedOutput);
    } else {
        assert.ok(pathExists(paths.originalExpectedOutput), 'The expected output does not exist; there is nothing to compare against! Has the expected output been created?\nCould not find: ' + paths.originalExpectedOutput)
    }
}

function createWebpackConfig(paths, optionsOriginal) {
    const config = require(path.join(paths.testStagingPath, 'webpack.config'));

    const extraOptionMaybe = extraOption ? { [extraOption]: true } : {};
    const options = Object.assign({
        // colors: false,
        silent: true,
        compilerOptions: {
            newLine: 'LF'
        }
    }, optionsOriginal, extraOptionMaybe);

    const tsLoaderPath = require('path').join(__dirname, "../../index.js");

    aliasLoader(config, tsLoaderPath, options);

    config.output.path = paths.webpackOutput;
    config.context = paths.testStagingPath;
    config.resolveLoader = config.resolveLoader || {};
    config.resolveLoader.alias = config.resolveLoader.alias || {};
    config.resolveLoader.alias.newLine = path.join(__dirname, 'newline.loader.js');

    const rules = config.module.rules || config.module.loaders;

    rules.push({ test: /\.js$/, loader: 'newLine' });
    return config;
}

function createWebpackWatchHandler(done, paths, testState, outputs, options, test) {
    return function (err, stats) {
        const patch = setPathsAndGetPatch(paths, testState);

        cleanHashFromOutput(stats, paths.webpackOutput);

        saveOutputIfRequired(saveOutputMode, paths, outputs, options, patch);

        copySync(paths.webpackOutput, paths.actualOutput);
        rimraf.sync(paths.webpackOutput);

        handleErrors(err, paths, outputs, patch, options);

        storeStats(stats, testState, paths, outputs, patch, options);

        compareFiles(paths, options, test, patch);

        copyPatchOrEndTest(paths.testStagingPath, testState.watcher, testState, done);
    }
}

function setPathsAndGetPatch(paths, testState) {
    let patch = '';
    if (testState.iteration > 0) {
        patch = 'patch' + (testState.iteration - 1);
        paths.actualOutput = path.join(paths.testStagingPath, 'actualOutput', patch);
        paths.expectedOutput = path.join(paths.testStagingPath, 'expectedOutput-' + typescriptVersion, patch);
        paths.originalExpectedOutput = path.join(testPath, 'expectedOutput-' + typescriptVersion, patch)
        mkdirp.sync(paths.actualOutput);
        mkdirp.sync(paths.expectedOutput);
        if (saveOutputMode) mkdirp.sync(paths.originalExpectedOutput);
    }
    return patch;
}

function saveOutputIfRequired(saveOutputMode, paths, outputs, options, patch) {
    // output results
    if (saveOutputMode) {
        // loop through webpackOutput and rename to .transpiled if needed
        glob.sync('**/*', { cwd: paths.webpackOutput, nodir: true }).forEach(function (file) {
            const patchedFileName = patch + '/' + file;
            outputs.currentSavedOutput[patchedFileName] = fs.readFileSync(path.join(paths.webpackOutput, file), 'utf-8');

            if (options.transpileOnly) {
                if (outputs.regularSavedOutput[patchedFileName] !== outputs.transpiledSavedOutput[patchedFileName]) {
                    const extension = path.extname(file);
                    fs.renameSync(
                        path.join(paths.webpackOutput, file),
                        path.join(paths.webpackOutput, path.basename(file, extension) + '.transpiled' + extension)
                    );
                }
            }
        });

        copySync(paths.webpackOutput, paths.originalExpectedOutput);
    }
}

function handleErrors(err, paths, outputs, patch, options) {
    if (err) {
        const errFileName = 'err.txt';

        const errString = err.toString()
            .replace(new RegExp(regexEscape(paths.testStagingPath + path.sep), 'g'), '')
            .replace(new RegExp(regexEscape(rootPath + path.sep), 'g'), '')
            .replace(new RegExp(regexEscape(rootPath), 'g'), '')
            .replace(/\.transpile/g, '');

        fs.writeFileSync(path.join(paths.actualOutput, errFileName), errString);
        if (saveOutputMode) {
            const patchedErrFileName = patch + '/' + errFileName;
            outputs.currentSavedOutput[patchedErrFileName] = errString;

            if (options.transpileOnly) {
                if (outputs.regularSavedOutput[patchedErrFileName] !== outputs.transpiledSavedOutput[patchedErrFileName]) {
                    fs.writeFileSync(path.join(paths.originalExpectedOutput, 'err.transpiled.txt'), errString);
                }
            }
            else {
                fs.writeFileSync(path.join(paths.originalExpectedOutput, errFileName), errString);
            }
        }
    }
}

function storeStats(stats, testState, paths, outputs, patch, options) {
    if (stats && stats.hash !== testState.lastHash) {
        testState.lastHash = stats.hash;

        const statsFileName = 'output.txt';

        // do a little magic to normalize `\` to `/` for asset output
        const newAssets = {};
        Object.keys(stats.compilation.assets).forEach(function (asset) {
            newAssets[asset.replace(/\\/g, "/")] = stats.compilation.assets[asset];
        });
        stats.compilation.assets = newAssets;

        const statsString = stats.toString({ timings: false, version: false, hash: false, builtAt: false })
            .replace(/^Built at: .+$/gm, '')
            .replace(new RegExp(regexEscape(paths.testStagingPath + path.sep), 'g'), '')
            .replace(new RegExp(regexEscape(rootPath + path.sep), 'g'), '')
            .replace(new RegExp(regexEscape(rootPath), 'g'), '')
            .replace(new RegExp(regexEscape(rootPathWithIncorrectWindowsSeparator), 'g'), '')
            .replace(/\.transpile/g, '');

        fs.writeFileSync(path.join(paths.actualOutput, statsFileName), statsString);
        if (saveOutputMode) {
            const patchedStatsFileName = patch + '/' + statsFileName;
            outputs.currentSavedOutput[patchedStatsFileName] = statsString;

            if (options.transpileOnly) {
                if (outputs.regularSavedOutput[patchedStatsFileName] !== outputs.transpiledSavedOutput[patchedStatsFileName]) {
                    fs.writeFileSync(path.join(paths.originalExpectedOutput, 'output.transpiled.txt'), statsString);
                }
            }
            else {
                fs.writeFileSync(path.join(paths.originalExpectedOutput, statsFileName), statsString);
            }
        }
    }
}

function compareFiles(paths, options, test, patch) {
    if (!saveOutputMode) {
        // massage any .transpiled. files
        glob.sync('**/*', { cwd: paths.expectedOutput, nodir: true }).forEach(function (file) {
            if (/\.transpiled/.test(file)) {
                if (options.transpileOnly) { // rename if we're in transpile mode
                    const extension = path.extname(file);
                    fs.renameSync(
                        path.join(paths.expectedOutput, file),
                        path.join(paths.expectedOutput, path.dirname(file), path.basename(file, '.transpiled' + extension) + extension)
                    );
                }
                else { // otherwise delete
                    fs.unlinkSync(path.join(paths.expectedOutput, file));
                }
            }
        });

        // compare actual to expected
        const actualFiles = glob.sync('**/*', { cwd: paths.actualOutput, nodir: true }),
            expectedFiles = glob.sync('**/*', { cwd: paths.expectedOutput, nodir: true })
                .filter(function (file) { return !/^patch/.test(file); }),
            allFiles = {};

        actualFiles.forEach(function (file) { allFiles[file] = true });
        expectedFiles.forEach(function (file) { allFiles[file] = true });

        Object.keys(allFiles).forEach(function (file) {
            const actual = getNormalisedFileContent(file, paths.actualOutput);
            const expected = getNormalisedFileContent(file, paths.expectedOutput);

            compareActualAndExpected(test, actual, expected, patch, file);
        });
    }
}

function copyPatchOrEndTest(testStagingPath, watcher, testState, done) {
    // check for new files to copy in
    const patchPath = path.join(testStagingPath, 'patch' + testState.iteration);
    if (fs.existsSync(patchPath)) {
        testState.iteration++;
        // can get inconsistent results if copying right away
        setTimeout(function () {
            copySync(patchPath, testStagingPath);
        }, 1000);
    }
    else {
        watcher.close(function () {
            // done is occasionally called twice for no known reason
            // when this happens the build fails with "Error: done() called multiple times" - not a meaningful failure
            if (!testState.doneHasBeenCalled) {
                testState.doneHasBeenCalled = true;
                done();
            }
        });
    }
}

/**
 * replace the elements in the output that can change depending on
 * environments; we want to generate a string that is as environment
 * independent as possible
 **/
function cleanHashFromOutput(stats, webpackOutput) {
    const escapedStagingPath = stagingPath.replace(new RegExp(regexEscape('\\'), 'g'), '\\\\');
    if (stats) {
        glob.sync('**/*', { cwd: webpackOutput, nodir: true }).forEach(function (file) {
            const content = fs.readFileSync(path.join(webpackOutput, file), 'utf-8')
                .split(stats.hash).join('[hash]')
                .replace(/\r\n/g, '\n')
                // Ignore complete paths
                .replace(new RegExp(regexEscape(escapedStagingPath), 'g'), '')
                // turn \\ to /
                .replace(new RegExp(regexEscape('\\\\'), 'g'), '/');

            fs.writeFileSync(path.join(webpackOutput, file), content);
        });
    }
}

function getNormalisedFileContent(file, location) {
    /** @type {string} */
    let fileContent;
    const filePath = path.join(location, file);
    try {
        const originalContent = fs.readFileSync(filePath).toString();
        fileContent = (file.indexOf('output.') === 0
            ? normaliseString(originalContent)
                // Built at: 2/15/2018 8:33:18 PM
                // Built at: 2018-2-11 17:50:52 (any time is fine for us)
                .replace(/^Built at: .+$/gm, '')
                // We have 'Module build failed (from /index.js' on Windows and 'Module build failed (from index.js' on Linux
                .replace(/Module build failed \(from \//gm, 'Module build failed (from ')
                .replace(/Module Warning \(from \//gm, 'Module Warning (from ')
                // We don't want a difference in the number of kilobytes to fail the build
                .replace(/\s+[\d]+([.][\d]*)? KiB\s+/g, ' A-NUMBER-OF KiB ')
                // We also don't want a difference in the number of bytes to fail the build
                .replace(/\s+\d+ bytes\s+/g, ' A-NUMBER-OF bytes ')
                // Ignore whitespace between:     Asset     Size  Chunks             Chunk Names
                .replace(/\s+Asset\s+Size\s+Chunks\s+Chunk Names/, '    Asset     Size  Chunks             Chunk Names')
                .replace(/ test\/comparison-tests\//,' /test/comparison-tests/')
                // Ignore 'at Object.loader (dist\index.js:32:15)' style row number / column number differences
                .replace(/(\(dist[\/|\\]\w*.js:)(\d*)(:)(\d*)(\))/g, function(match, openingBracketPathAndColon, lineNumber, colon, columnNumber, closingBracket){
                    return openingBracketPathAndColon + 'irrelevant-line-number' + colon + 'irrelevant-column-number' + closingBracket;
                })
                // Ignore path differences in TS error output
                .replace(/(TS6305:[^']+')([^']+?)([^\\\/']+')([^']+')([^']+?)([^\\\/']+'.*)$/gm, function(match, messageStart, outputFileBaseDir, outputFileName, messageMiddle, sourceFileBaseDir, sourceFileName) {
                    return messageStart + outputFileName + messageMiddle + sourceFileName;
                })
            : normaliseString(originalContent))
            // Ignore 'at C:/source/ts-loader/dist/index.js:90:19' style row number / column number differences
            .replace(/at (.*)(dist[\/|\\]\w*.js:)(\d*)(:)(\d*)/g, function(match, spaceAndStartOfPath, remainingPathAndColon, lineNumber, colon, columnNumber){
                return 'at ' + remainingPathAndColon + 'irrelevant-line-number' + colon + 'irrelevant-column-number';
            })
            // strip C:/projects/ts-loader/.test/
            .replace(/(C\:\/)?[\w|\/]*\/(ts-loader|workspace)\/\.test/ig, '')
            .replace(/webpack:\/\/(C:\/)?[\w|\/|-]*\/comparison-tests\//ig, 'webpack://comparison-tests/')
            .replace(/WEBPACK FOOTER\/n\/ (C:\/)?[\w|\/|-]*\/comparison-tests\//ig, 'WEBPACK FOOTER/n/ /ts-loader/test/comparison-tests/')
            .replace(/!\** (C\:\/)?[\w|\/|-]*\/comparison-tests\//ig, '!*** /ts-loader/test/comparison-tests/')
            .replace(/\/ (C\:\/)?[\w|\/|-]*\/comparison-tests\//ig, '/ /ts-loader/test/comparison-tests/')
            // with webpack 4 there are different numbers of *s on Windows and on Linux
            .replace(/\*{10}\**/g, '**********');
    } catch (e) {
        fileContent = '!!!' + filePath + ' doesn\'t exist!!!';
    }
    return fileContent;
}

function normaliseString(platformSpecificContent) {
    return platformSpecificContent
        .replace(/(?:\\[rn]|[\r\n]+)+/g, '\n') // https://stackoverflow.com/a/20023647/761388
        .replace(/\/r\/n/g, '/n')
        .replace(/\\r\\n/g, '\\n') // bundle.js output needs this; tsConfigNotReadable for instance
        // Convert '/' to '\' and back to '/' so slashes are treated the same
        // whether running / generated on windows or *nix
        .replace(new RegExp(regexEscape('/'), 'g'), '\\')
        .replace(new RegExp(regexEscape('\\'), 'g'), '/')
        .replace(new RegExp(regexEscape('//'), 'g'), '/')
        // replace C:/source/ts-loader/index.js or /home/travis/build/TypeStrong/ts-loader/index.js with ts-loader
        .replace(/ \S+[\/|\\](ts-loader|workspace)[\/|\\]index.js/g, 'ts-loader')
        // replace (C:/source/ts-loader/dist/index.js with (ts-loader)
        .replace(/\(\S+[\/|\\](ts-loader|workspace)[\/|\\]dist[\/|\\]index.js:\d*:\d*\)/g, '(ts-loader)');
}

/**
 * If a test is marked as flaky then don't fail the build if it doesn't pass
 * Instead, report the differences and carry on
 */
function compareActualAndExpected(test, actual, expected, patch, file) {
    const actualString = actual.toString();
    const expectedString = expected.toString();
    if (testIsFlaky) {
        try {
            assert.equal(actualString, expectedString, (patch ? patch + '/' : patch) + file + ' is different between actual and expected');
        }
        catch (e) {
            console.log("\nFlaky test error!\n");
            console.log("MESSAGE:\n" + e.message, '\n');
            console.log('EXPECTED:\n', e.expected, '\n');
            console.log("ACTUAL:\n", e.actual, '\n');
        }
    }
    else {
        assert.equal(actualString, expectedString, (patch ? patch + '/' : patch) + file + ' is different between actual and expected');
    }
}
