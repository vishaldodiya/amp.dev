/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
require('module-alias/register');

const {promisify} = require('util');
const {Signale} = require('signale');
const gulp = require('gulp');
const once = require('gulp-once');
const abe = require('amp-by-example');
const through = require('through2');
const del = require('del');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const crypto = require('crypto');
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const nunjucks = require('nunjucks');

const MarkdownDocument = require('@lib/pipeline/markdownDocument.js');
const utils = require('@lib/utils');
const config = require('@lib/config.js');

// Where to import the samples from
const SAMPLE_SRC = utils.project.absolute('examples/source');
// The pod path for the documentation pages
const DOCUMENTATION_POD_PATH = 'content/amp-dev/documentation/examples/documentation';
// Where to store the samples inside the Grow pod in
const DOCUMENTATION_DEST = utils.project.absolute(`pages/${DOCUMENTATION_POD_PATH}`);
// What Grow template to use to render the sample's manual
const DOCUMENTATION_TEMPLATE = '/views/examples/documentation.j2';
// The pod path for the previews
const PREVIEW_POD_PATH = 'content/amp-dev/documentation/examples/previews';
// Where to store the sample preview files with header
const PREVIEW_DEST = utils.project.absolute(`pages/${PREVIEW_POD_PATH}`);
// What template to use to render the preview
const PREVIEW_TEMPLATE = '/views/examples/preview.j2';
// Path to the story embed snippet
const STORY_EMBED_SNIPPET = utils.project.absolute('frontend/js/story-progress.js');
// Path to the ads embed template
const ADS_EMBED_TEMPLATE = utils.project.absolute('frontend/templates/views/examples/embed-ads.j2');
// Where to store the embeds for Grow
const EMBED_DEST = utils.project.absolute('dist/examples/embeds');
// Base to define the request path for Grow
const ROUTE_BASE = '/documentation/examples';
// Path to store the cache in
const CACHE_DEST = utils.project.absolute('.cache/examples.json');
// Path the all source files are written to, to vend them via express
const SOURCE_DEST = utils.project.absolute('dist/examples/sources');
// The API host used by samples depending on one
const API_HOST = 'https://amp-by-example-api.appspot.com';
// The host used for samples depending on a backend
const BACKEND_HOST = 'https://ampbyexample.com';
// The path where the playground's example sitemap is written
const SITEMAP_DEST = utils.project.absolute('examples/static/samples/samples.json');


class SamplesBuilder {
  constructor() {
    this._log = new Signale({
      'interactive': false,
      'scope': 'Samples builder',
    });

    // Used to cache various properties to save computing time
    this._cache = {};
    // Holds all relevant sample informations after samplew have been parsed
    this._sitemap = {};
  }

  /**
   * Builds samples and previews, optionally watching for changes.
   * @param {boolean} watch  Watch for changes
   * @return {Promise<void>} Resolves when build is done
   */
  async build(watch) {
    // Configure cache
    this._cache[STORY_EMBED_SNIPPET] = await readFileAsync(STORY_EMBED_SNIPPET);
    this._cache[ADS_EMBED_TEMPLATE] = (await readFileAsync(ADS_EMBED_TEMPLATE)).toString();
    this._cache.categories = {};

    // If samples should be rebuild (due to architectural changes for example)
    // then you should be able to clean the sample build destinations
    if (!watch && config.options['clean-samples'] === true) {
      this._log.info('Cleaning sample destinations for rebuild ...');
      del.sync([
        // Clean old structure with multiple collections
        utils.project.absolute(`/pages/${DOCUMENTATION_POD_PATH}/../**/*`),
        '!' + utils.project.absolute(`/pages/${DOCUMENTATION_POD_PATH}/../`),
        '!' + utils.project.absolute(`/pages/${DOCUMENTATION_POD_PATH}/../_blueprint.yaml`),
        '!' + utils.project.absolute(`/pages/${DOCUMENTATION_POD_PATH}/../index.html`),

        `${DOCUMENTATION_DEST}/**/*`,
        `!${DOCUMENTATION_DEST}`,
        `!${DOCUMENTATION_DEST}/_blueprint.yaml`,

        `${PREVIEW_DEST}/**/*`,
        `!${PREVIEW_DEST}`,
        `!${PREVIEW_DEST}/_blueprint.yaml`,

        `${SOURCE_DEST}`,
        `${EMBED_DEST}`,
        CACHE_DEST,
      ], {
        'force': true,
      });
    }

    if (!watch && config.isDevMode() && module.parent) {
      this._watch();
    }

    this._log.start('Starting to build samples ...');

    return new Promise((resolve, reject) => {
      let stream = gulp.src([
        `${SAMPLE_SRC}/*/*.html`, `${SAMPLE_SRC}/*/*/*.html`], {'read': true});

      // Only build samples changed since last run and if it's not a fresh build
      if ((config.options['clean-samples'] && watch) || !config.options['clean-samples']) {
        stream = stream.pipe(once({
          'context': false,
          'file': CACHE_DEST,
        }));
      }

      stream = stream.pipe(through.obj(async (sample, encoding, callback) => {
        try {
          this._log.await(`Building sample ${sample.relative} ...`);
          const parsedSample = await this._parseSample(sample);

          // Skip samples that are drafts for alle envs except development
          if (parsedSample.document.metadata.draft && config.environment !== 'development') {
            callback();
            return;
          }

          if (!parsedSample.document.metadata.disablePlayground &&
              !parsedSample.document.metadata.drafts) {
            this._addToSitemap(sample, parsedSample);
          }

          // Build various documents and sources that are needed for Grow
          // to successfully render the example and for the playground
          const files = [
            ...this._createDocumentation(sample, parsedSample),
            ...this._buildRawSources(sample, parsedSample),
            ...this._createPreview(sample, parsedSample),
            ...this._renderEmbed(sample, parsedSample),
          ];

          // Since stream.push doesn't allow to push multiple files at once
          /* eslint-disable guard-for-in */
          for (const file of files) {
            stream.push(file);
          }
        } catch (error) {
          this._log.error(error);
        }
        callback();
      }));

      stream.pipe(gulp.dest((file) => {
        file.dirname = `${SAMPLE_SRC}/${this._getCategory(file)}`;
        if (file.isSourceFile) {
          return SOURCE_DEST;
        } else if (file.isPreview) {
          // Remove double name from path to flatten structure for Grow
          file.dirname = `${SAMPLE_SRC}`;
          return PREVIEW_DEST;
        } else if (file.isEmbed) {
          return EMBED_DEST;
        } else {
          // Remove double name from path to flatten structure for Grow
          file.dirname = `${SAMPLE_SRC}`;
          return DOCUMENTATION_DEST;
        }
      }));

      stream.on('error', (error) => {
        this._log.fatal('There was an error building the samples', error);
        reject(error);
      });

      stream.on('end', async () => {
        this._log.success('Built samples.');
        await this._generateSitemap();
        resolve();
      });
    });
  }

  /**
   * Parse a sample source file into a JSON using the parser from the
   * ampbyexample.com package and while doing so updates some fields
   * @param {Vinyl} sample     The file from which the sample is parsed
   * @return {Promise<Object>} The sample parsed by abe.com
   */
  async _parseSample(sample) {
    const samplePath = sample.path;
    // normalize sample path in case it's defined in a directory
    if (sample.path.endsWith('/index.html')) {
      sample.path = path.dirname(sample.path) + '.html';
    }
    const platformHost = config.getHost(config.hosts.platform);
    const parsedSample = await abe.parseSample(samplePath, {
      'base_path': `${platformHost}${this._getBaseRoute(sample)}`,
      'canonical': `${platformHost}${this._getDocumentationRoute(sample)}`,
      'preview': `${platformHost}${this._getPreviewRoute(sample)}`,
      'hosts': {
        'platform': platformHost,
        'api': API_HOST,
        'backend': BACKEND_HOST,
        'preview': config.hosts.preview.base,
      },
    }, sample.contents.toString());

    // parsedSample.filePath is absolute but needs to be relative in order
    // to use it to build a URL to GitHub
    parsedSample.filePath = parsedSample.filePath.replace(path.join(__dirname, '../../../'), '');

    // Add the delivery path of the manual for preview rendering
    parsedSample.route = this._getDocumentationRoute(sample);

    // Rewrite some markdown to be consumable by Grow
    for (const index in parsedSample.document.sections) {
      // Replace GitHub sourcecode syntax by python-markdown
      let markdown = parsedSample.document.sections[index].doc_;
      markdown = MarkdownDocument.rewriteCodeBlocks(markdown);
      markdown = MarkdownDocument.escapeMustacheTags(markdown);

      // Splice out sourcecode blocks to preserve whitespace
      const codeBlocks = {};
      const CODE_BLOCK_PATTERN = /\[sourcecode.*?\[\/sourcecode]/gms;
      markdown = markdown.replace(CODE_BLOCK_PATTERN, (match) => {
        // Hash and save the code block for later restore
        let hash = crypto.createHash('sha1');
        hash.update(match);
        hash = hash.digest('base64');

        codeBlocks[hash] = match;
        return hash;
      });

      // Replace empty lines with leading space with just a new line
      markdown = markdown.replace(/^\s+/gm, '\n');

      // Replace new lines with following space or multiple new lines
      // by just a new line
      markdown = markdown.replace(/(\n +|\n{2,})/gm, '\n\n');

      // Restore codeblocks
      /* eslint-disable guard-for-in */
      for (const hash of Object.keys(codeBlocks)) {
        markdown = markdown.replace(hash, codeBlocks[hash]);
      }

      parsedSample.document.sections[index].doc_ = markdown;
    }

    return parsedSample;
  }

  /**
   * Adds a sample to the sitemap object for the playground to then render
   * a list of available samples
   * @param {Vinyl} sample        The file from which the sample is parsed
   * @param {Object} parsedSample The parsed sample
   */
  _addToSitemap(sample, parsedSample) {
    const format = this._getSampleFormat(parsedSample);
    const formatCategories = this._sitemap[format] || {};

    const category = require(path.join(SAMPLE_SRC, this._getCategory(sample, true), 'index.json'));
    const categorySamples = formatCategories[category.publicName] || {
      'name': category.publicName,
      'examples': [],
    };
    categorySamples.examples.push({
      'title': parsedSample.document.title,
      'url': `${config.getHost(config.hosts.preview)}` +
          this._getSourceRoute(sample),
    });

    formatCategories[category.publicName] = categorySamples;
    this._sitemap[format] = formatCategories;
  }

  /**
   * Takes what has been saved to this._sitemap and adds a sitemap.json to
   * the gulp stream that is usable by the playground
   * @type {Vinyl}
   */
  async _generateSitemap() {
    for (const [format, categories] of Object.entries(this._sitemap)) {
      this._sitemap[format] = {
        'title': format,
        'name': format,
        'categories': [],
      };

      for (const [name, category] of Object.entries(categories)) {
        this._sitemap[format].categories.push({
          'name': name,
          'examples': category.examples,
        });
      }
    }

    try {
      await writeFileAsync(SITEMAP_DEST, JSON.stringify(this._sitemap), {
        flag: 'wx+',
      });
      this._log.success('Wrote sample sitemap.');
    } catch (_) {
      this._log.info('Samples sitemap already exists');
    }
  }


  /**
   * Parses the category from a sample path which is the first level
   * directory name after the base path
   * @param  {Vinyl}   sample    The sample from the gulp stream
   * @param  {Boolean} [ordered] Flag if the ordinal number should be included
   * @return {string}            The category
   */
  _getCategory(sample, ordered = false) {
    // Check if the category has already been computed
    let category = this._cache.categories[sample.path];
    if (!category) {
      category = sample.dirname.replace(`${SAMPLE_SRC}/`, '');
      category = category.split('/')[0];

      this._cache.categories[sample.path] = category;
    }

    // Check if the category should contain ordinal
    if (!ordered) {
      return category.replace(/^\d+./, '');
    }

    return category;
  }

  /**
   * Takes the path of the sample vinyl and creates a server relative URL
   * to use for routing and build other URLs
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {string}       The route
   */
  _getBaseRoute(sample) {
    return `${ROUTE_BASE}/${this._getCategory(sample)}/${sample.stem.toLowerCase()}`;
  }

  /**
   * Takes the path of the sample vinyl and creates a server relative URL
   * to use for routing and source canonical
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {string}       The route
   */
  _getDocumentationRoute(sample) {
    let base = this._getBaseRoute(sample);
    if (!base.endsWith('/index.html')) {
      base += '/index.html';
    }
    return base;
  }

  /**
   * Takes the path of the sample vinyl and creates a server relative URL
   * to use for the previews
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {string}       The route
   */
  _getPreviewRoute(sample) {
    return this._getBaseRoute(sample) +
      '/preview/index.html';
  }

  /**
   * Takes the path of the sample vinyl and creates a server relative URL
   * to use for the source files
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {string}       The route
   */
  _getSourceRoute(sample) {
    return `${this._getBaseRoute(sample)}`;
  }

  /**
   * Takes the path of the sample vinyl and creates a server relative URL
   * to use for the source files
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {string}       The route
   */
  _getEmbedRoute(sample) {
    return `${this._getBaseRoute(sample)}/embed`;
  }

  /**
   * Creates a markdown document referencing the JSON that is going to be
   * created by _createDataSource
   * @param  {Vinyl} sample The sample from the gulp stream
   * @return {Vinyl}
   */
  _createDocumentation(sample, parsedSample) {
    // Create the actual page that is rendered by Grow and add needed
    // frontmatter that is required ...
    const manual = sample.clone();

    // List of metadata properties to transfer from sample header to
    // markdown header.
    const metadataToTransfer = [
      'author',
      'translator',
      'contributors',
    ];

    const header = {
      '$$injectAmpDependencies': false,
      '$title': parsedSample.document.title,
      '$view': DOCUMENTATION_TEMPLATE,
      '$category': this._getCategory(sample, true),
      '$path': this._getDocumentationRoute(sample),
      '$localization': {
        'path': `/{locale}${this._getDocumentationRoute(sample)}`,
      },
      'description': parsedSample.document.description(),
      'source': this._getSourceRoute(sample),
    };

    for (const metadataProperty of metadataToTransfer) {
      if (parsedSample.document.metadata[metadataProperty]) {
        header[metadataProperty] = parsedSample.document.metadata[metadataProperty];
      }
    }

    // Build actual file needed for Grow to render the documentation
    manual.contents = Buffer.from([
      '---',
      yaml.safeDump(header, {'lineWidth': 500}),
      // Add example manually as constructors may not be quoted
      `example: !g.json /${DOCUMENTATION_POD_PATH}/${manual.stem}.json`,
      // ... and some additional information that is used by the example teaser
      this._getTeaserData(parsedSample),
      '---',
    ].join('\n'));
    manual.extname = '.html';

    // ... and the parsed sample as data source to render the manual
    const data = manual.clone();
    data.contents = Buffer.from(JSON.stringify(parsedSample));
    data.extname = '.json';

    return [manual, data];
  }

  /**
   * Builds a YAML string that is added to the manual document to
   * build a nice teaser for the sample
   * @param  {Object} parsedSample
   * @return {string}
   */
  _getTeaserData(parsedSample) {
    const teaserData = {};
    teaserData.formats = [this._getSampleFormat(parsedSample)];
    teaserData.used_components = this._getUsedComponents(parsedSample);

    if (parsedSample.document.metadata.teaserImage) {
      teaserData.teaser = {'image': {
        'src': parsedSample.document.metadata.teaserImage,
      }};
    }

    return yaml.safeDump(teaserData, {'lineWidth': 500});
  }

  /**
   * Used to determine the sample format by string
   * @param  {Object} parsedSample
   * @return {string}
   */
  _getSampleFormat(parsedSample) {
    if (parsedSample.document.isAmpStory) {
      return 'stories';
    }
    if (parsedSample.document.isAmpAds) {
      return 'ads';
    }
    if (parsedSample.document.isAmpEmail) {
      return 'email';
    }

    // Use websites as fallback as isAmpWebsites could be true for all formats
    return 'websites';
  }

  /**
   * Parses all components used in sample and gives them back as an Array
   * @param  {Object} parsedSample
   * @return {Object}
   */
  _getUsedComponents(parsedSample) {
    // Dirty RegEx to quickly parse component names from head
    const COMPONENT_PATTERN = /<script[^>]*?custom-(?<type>[a-z]+)="(?<name>[^"]+)"[^>]*src="[^"]+-(?<version>\d+(\.\d+)*)\.js"[^>]*>\s*<\/script>/g;

    const usedComponents = {};
    parsedSample.document.head.replace(COMPONENT_PATTERN, (script, type, name, version) => {
      usedComponents[name] = {
        version,
        type,
      }
    });

    return usedComponents;
  }

  /**
   * Creates various HTML documents that are then served statically for
   * use in playground and its embeds
   * @param  {Vinyl}  sample       The sample from the gulp stream
   * @param  {Object} parsedSample The sample parsed by abe.com
   * @return {Array<Vynyl>}        An array of Vinyl files to write
   */
  _buildRawSources(sample, parsedSample) {
    const sources = [];

    // Keep the full sample for the big playground
    const fullSource = sample.clone();
    fullSource.contents = Buffer.from(parsedSample.source);
    fullSource.basename = fullSource.basename.toLowerCase();
    fullSource.dirname = `${fullSource.dirname}/${this._getCategory(sample)}`;
    fullSource.isSourceFile = true;

    sources.push(fullSource);

    // ... and only build snippet sources if they can run standalone
    if (!parsedSample.document.metadata.standaloneSnippets) {
      return sources;
    }

    const TITLE_PLACEHOLDER = '<!-- samplesBuilder: title-->';
    const SECTION_PLACEHOLDER = '<!-- samplesBuilder: section-->';
    // Then create a document structure that can be used to write a full document
    // for each of the individual sections
    const barebone = [
      '<!doctype html>\n<html ⚡>\n<head>',
      parsedSample.document.head,
      `<title>${parsedSample.document.title} / ${TITLE_PLACEHOLDER}</title>`,
      '<style amp-custom>',
      parsedSample.document.styles,
      '</style>\n<meta name="robots" content="noindex, nofollow">\n</head>',
      parsedSample.document.body,
      parsedSample.document.elementsAfterBody,
      `${SECTION_PLACEHOLDER}</body>\n</html>`,
    ].join('\n');

    for (const section of parsedSample.document.sections) {
      // Check if the section qualifies to show standalone
      if (section.preview.replace(/\s/g, '') == '' || !section.inBody) {
        continue;
      }

      let contents = barebone.replace(SECTION_PLACEHOLDER, section.preview);
      contents = contents.replace(TITLE_PLACEHOLDER, section.id);

      const sectionSource = fullSource.clone();
      sectionSource.isSourceFile = true;
      sectionSource.basename = sectionSource.basename.toLowerCase();
      sectionSource.contents = Buffer.from(contents);
      sectionSource.extname = `-${section.id}.html`;

      sources.push(sectionSource);
    }

    return sources;
  }

  /**
   * Renders embedabble preview versions - only valid for AMP story samples
   * that need a JS snippet attached
   * @param  {Vinyl} sample
   * @param  {Object} parsedSample
   * @return {Array<Object>}
   */
  _renderEmbed(sample, parsedSample) {
    // Render embed file for stories enabling to jump to a stories page given
    // via GET parameter, for ads to show in the preview
    if (parsedSample.document.isAmpStory || parsedSample.document.isAmpAds) {
      const embed = sample.clone();
      embed.dirname = `${embed.dirname}/${this._getCategory(sample)}`;
      embed.basename = embed.basename.toLowerCase();
      embed.isEmbed = true;

      if (parsedSample.document.isAmpStory) {
        embed.contents = Buffer.from(
            parsedSample.source.replace('</body>',
                `<script>${this._cache[STORY_EMBED_SNIPPET]}</script></body>`)
        );
      }

      if (parsedSample.document.isAmpAds) {
        const adsEmbed = nunjucks.renderString(this._cache[ADS_EMBED_TEMPLATE], {
          'metadata': parsedSample.document.metadata,
          'canonical': `${config.getHost(config.hosts.platform)}` +
              `${this._getDocumentationRoute(sample)}`,
          'source': this._getSourceRoute(sample),
          'title': parsedSample.document.metadata,
        });
        embed.contents = Buffer.from(adsEmbed);
      }

      return [embed];
    }

    return [];
  }

  /**
   * Creates another document in the Grow pod used to show the preview
   * @param  {Vinyl} sample The sample from the gulp stream
   * @param  {Object} parsedSample The sample parsed by abe.com
   * @return {Vinyl}
   */
  _createPreview(sample, parsedSample) {
    // Check if the sample should have a preview at all
    if (!(parsedSample.document.metadata.preview ||
          parsedSample.document.isAmpStory)) {
      return [];
    }

    const preview = sample.clone();

    // Set flag to determine correct output location
    preview.isPreview = true;
    preview.contents = Buffer.from([
      '---',
      yaml.safeDump({
        '$title': parsedSample.document.title,
        '$view': PREVIEW_TEMPLATE,
        '$category': this._getCategory(sample),
        '$path': this._getPreviewRoute(sample),
        '$localization': {
          'path': `/{locale}${this._getPreviewRoute(sample)}`,
        },
        'formats': [this._getSampleFormat(parsedSample)],
        'source': this._getSourceRoute(sample),
        'embed': this._getEmbedRoute(sample),
      }, {'lineWidth': 500}),
      `example: !g.json /${DOCUMENTATION_POD_PATH}/${preview.stem}.json`,
      '---',
    ].join('\n'));

    return [preview];
  }

  _watch() {
    this._log.watch('Watching samples for changes ...');
    gulp.watch(SAMPLE_SRC, this.build.bind(this, true));
  }
}

if (!module.parent) {
  (async () => {
    const samplesBuilder = new SamplesBuilder();
    samplesBuilder.build();
  })();
}

module.exports = {
  'samplesBuilder': new SamplesBuilder(),
  'SOURCE_DEST': SOURCE_DEST,
};
