// Copyright 2014 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import {GaxiosOptions} from 'gaxios';
import {DefaultTransporter} from 'google-auth-library';
import {
  FragmentResponse,
  Schema,
  SchemaItem,
  SchemaMethod,
  SchemaParameters,
  SchemaResource,
  Schemas,
} from 'googleapis-common';
import * as mkdirp from 'mkdirp';
import * as nunjucks from 'nunjucks';
import * as path from 'path';
import {URL} from 'url';
import * as util from 'util';
import Q from 'p-queue';
import * as prettier from 'prettier';
import {downloadDiscoveryDocs} from './download';

const writeFile = util.promisify(fs.writeFile);
const readDir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);

const FRAGMENT_URL =
  'https://storage.googleapis.com/apisnippets-staging/public/';

const srcPath = path.join(__dirname, '../../../src');
const TEMPLATES_DIR = path.join(srcPath, 'generator/templates');
const API_TEMPLATE = path.join(TEMPLATES_DIR, 'api-endpoint.njk');
const RESERVED_PARAMS = ['resource', 'media', 'auth'];

export interface GeneratorOptions {
  debug?: boolean;
  includePrivate?: boolean;
}

function getObjectType(item: SchemaItem): string {
  if (item.additionalProperties) {
    const valueType = getType(item.additionalProperties);
    return `{ [key: string]: ${valueType}; }`;
  } else if (item.properties) {
    const fields = item.properties;
    const objectType = Object.keys(fields)
      .map(field => `${cleanPropertyName(field)}?: ${getType(fields[field])};`)
      .join(' ');
    return `{ ${objectType} }`;
  } else {
    return 'any';
  }
}

function isSimpleType(type: string): boolean {
  if (type.indexOf('{') > -1) {
    return false;
  }
  return true;
}

function cleanPropertyName(prop: string) {
  const match = prop.match(/[-@.]/g);
  return match ? `'${prop}'` : prop;
}

function camelify(name: string) {
  // If the name has a `-`, remove it and camelize.
  // Ex: `well-known` => `wellKnown`
  if (name.includes('-')) {
    const parts = name.split('-').filter(x => !!x);
    name = parts
      .map((part, i) => {
        if (i === 0) {
          return part;
        }
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('');
  }
  return name;
}

function getType(item: SchemaItem): string {
  if (item.$ref) {
    return `Schema$${item.$ref}`;
  }
  switch (item.type) {
    case 'integer':
      return 'number';
    case 'object':
      return getObjectType(item);
    case 'array': {
      const innerType = getType(item.items!);
      if (isSimpleType(innerType)) {
        return `${innerType}[]`;
      } else {
        return `Array<${innerType}>`;
      }
    }
    default:
      return item.type!;
  }
}

export class Generator {
  private transporter = new DefaultTransporter();
  private requestQueue = new Q({concurrency: 50});
  private env: nunjucks.Environment;

  /**
   * A multi-line string is turned into one line.
   * @param str String to process
   * @return Single line string processed
   */
  private oneLine(str?: string) {
    return str ? str.replace(/\n/g, ' ') : '';
  }

  /**
   * Clean a string of comment tags.
   * @param str String to process
   * @return Single line string processed
   */
  private cleanComments(str?: string) {
    // Convert /* into /x and */ into x/
    return str ? str.replace(/\*\//g, 'x/').replace(/\/\*/g, '/x') : '';
  }

  private getPathParams(params: SchemaParameters) {
    const pathParams = new Array<string>();
    if (typeof params !== 'object') {
      params = {};
    }
    Object.keys(params).forEach(key => {
      if (params[key].location === 'path') {
        pathParams.push(key);
      }
    });
    return pathParams;
  }

  private getSafeParamName(param: string) {
    if (RESERVED_PARAMS.indexOf(param) !== -1) {
      return param + '_';
    }
    return param;
  }

  private hasResourceParam(method: SchemaMethod) {
    return method.parameters && method.parameters['resource'];
  }

  private options: GeneratorOptions;

  private state = new Map<string, string[]>();

  /**
   * Generator for generating API endpoints
   * @param options Options for generation
   */
  constructor(options: GeneratorOptions = {}) {
    this.options = options;
    this.env = new nunjucks.Environment(
      new nunjucks.FileSystemLoader(TEMPLATES_DIR),
      {trimBlocks: true}
    );
    this.env.addFilter('buildurl', buildurl);
    this.env.addFilter('oneLine', this.oneLine);
    this.env.addFilter('getType', getType);
    this.env.addFilter('cleanPropertyName', cleanPropertyName);
    this.env.addFilter('cleanComments', this.cleanComments);
    this.env.addFilter('camelify', camelify);
    this.env.addFilter('getPathParams', this.getPathParams);
    this.env.addFilter('getSafeParamName', this.getSafeParamName);
    this.env.addFilter('hasResourceParam', this.hasResourceParam);
    this.env.addFilter('cleanPaths', str => {
      return str
        ? str
            .replace(/\/\*\//gi, '/x/')
            .replace(/\/\*`/gi, '/x')
            .replace(/\*\//gi, 'x/')
            .replace(/\\n/gi, 'x/')
        : '';
    });
  }

  /**
   * Add a requests to the rate limited queue.
   * @param opts Options to pass to the default transporter
   */
  private request<T>(opts: GaxiosOptions) {
    return this.requestQueue.add(() => {
      return this.transporter.request<T>(opts);
    });
  }

  /**
   * Log output of generator. Works just like console.log.
   */
  private log(...args: string[]) {
    if (this.options && this.options.debug) {
      console.log(...args);
    }
  }

  /**
   * Write to the state log, which is used for debugging.
   * @param id DiscoveryRestUrl of the endpoint to log
   * @param message
   */
  private logResult(id: string, message: string) {
    if (!this.state.has(id)) {
      this.state.set(id, new Array<string>());
    }
    this.state.get(id)!.push(message);
  }

  /**
   * Generate all APIs and write to files.
   */
  async generateAllAPIs(discoveryUrl: string, useCache: boolean) {
    const ignore = require('../../../ignore.json').ignore as string[];
    const discoveryPath = path.join(__dirname, '../../../discovery');
    if (useCache) {
      console.log('Reading from cache...');
    } else {
      await downloadDiscoveryDocs({
        includePrivate: this.options.includePrivate,
        discoveryUrl,
        downloadPath: discoveryPath,
      });
    }

    const indexPath = path.join(discoveryPath, 'index.json');
    const file = await readFile(indexPath, 'utf8');
    const apis = (JSON.parse(file) as Schemas).items;
    const queue = new Q({concurrency: 25});
    console.log(`Generating ${apis.length} APIs...`);
    queue.addAll(
      apis.map(api => {
        return async () => {
          // look at ignore.json to find a list of APIs to ignore
          if (ignore.includes(api.id)) {
            this.log(`Skipping API ${api.id}`);
            return;
          }
          this.log(`Generating API for ${api.id}...`);
          this.logResult(
            api.discoveryRestUrl,
            'Attempting first generateAPI call...'
          );
          try {
            const apiPath = path.join(
              discoveryPath,
              api.id.replace(':', '-') + '.json'
            );
            await this.generateAPI(apiPath);
            this.logResult(api.discoveryRestUrl, 'GenerateAPI call success!');
          } catch (e) {
            this.logResult(
              api.discoveryRestUrl,
              `GenerateAPI call failed with error: ${e}, moving on.`
            );
            console.error(`Failed to generate API: ${api.id}`);
            console.error(e);
            console.log(
              api.id +
                '\n-----------\n' +
                util.inspect(this.state.get(api.discoveryRestUrl), {
                  maxArrayLength: null,
                }) +
                '\n'
            );
          }
        };
      })
    );
    try {
      await queue.onIdle();
      await this.generateIndex(apis);
    } catch (e) {
      console.log(util.inspect(this.state, {maxArrayLength: null}));
    }
  }

  async generateIndex(metadata: Schema[]) {
    const apis: {[index: string]: {[index: string]: string}} = {};
    const apisPath = path.join(srcPath, 'apis');
    const indexPath = path.join(apisPath, 'index.ts');
    const rootIndexPath = path.join(apisPath, '../', 'index.ts');

    // Dynamically discover available APIs
    const files: string[] = await readDir(apisPath);
    for (const file of files) {
      const filePath = path.join(apisPath, file);
      if (!(await util.promisify(fs.stat)(filePath)).isDirectory()) {
        continue;
      }
      apis[file] = {};
      const files: string[] = await readDir(path.join(apisPath, file));
      for (const version of files) {
        const parts = path.parse(version);
        if (!version.endsWith('.d.ts') && parts.ext === '.ts') {
          apis[file][version] = parts.name;
          const desc = metadata.filter(x => x.name === file)[0].description;
          // generate the index.ts
          const apiIdxPath = path.join(apisPath, file, 'index.ts');
          const apiIndexData = {name: file, api: apis[file]};
          await this.render('api-index.njk', apiIndexData, apiIdxPath);
          // generate the package.json
          const pkgPath = path.join(apisPath, file, 'package.json');
          const packageData = {name: file, desc};
          await this.render('package.json.njk', packageData, pkgPath);
          // generate the README.md
          const rdPath = path.join(apisPath, file, 'README.md');
          await this.render('README.md.njk', {name: file, desc}, rdPath);
          // generate the tsconfig.json
          const tsPath = path.join(apisPath, file, 'tsconfig.json');
          await this.render('tsconfig.json.njk', {}, tsPath);
          // generate the webpack.config.js
          const wpPath = path.join(apisPath, file, 'webpack.config.js');
          await this.render('webpack.config.js.njk', {name: file}, wpPath);
        }
      }
    }
    await this.render('index.njk', {apis}, indexPath);
    await this.render('root-index.njk', {apis}, rootIndexPath);
  }

  /**
   * Given a discovery doc, parse it and recursively iterate over the various
   * embedded links.
   */
  private getFragmentsForSchema(
    apiDiscoveryUrl: string,
    schema: SchemaResource,
    apiPath: string,
    tasks: Array<() => Promise<void>>
  ) {
    if (schema.methods) {
      for (const methodName in schema.methods) {
        // eslint-disable-next-line no-prototype-builtins
        if (schema.methods.hasOwnProperty(methodName)) {
          const methodSchema = schema.methods[methodName];
          methodSchema.sampleUrl = apiPath + '.' + methodName + '.frag.json';
          tasks.push(async () => {
            this.logResult(apiDiscoveryUrl, 'Making fragment request...');
            this.logResult(apiDiscoveryUrl, methodSchema.sampleUrl);
            try {
              const res = await this.request<FragmentResponse>({
                url: methodSchema.sampleUrl,
              });
              this.logResult(apiDiscoveryUrl, 'Fragment request complete.');
              if (
                res.data &&
                res.data.codeFragment &&
                res.data.codeFragment['Node.js']
              ) {
                let fragment = res.data.codeFragment['Node.js'].fragment;
                fragment = fragment.replace(/\/\*/gi, '/<');
                fragment = fragment.replace(/\*\//gi, '>/');
                fragment = fragment.replace(/`\*/gi, '`<');
                fragment = fragment.replace(/\*`/gi, '>`');
                const lines = fragment.split('\n');
                lines.forEach((line: string, i: number) => {
                  lines[i] = '*' + (line ? ' ' + lines[i] : '');
                });
                fragment = lines.join('\n');
                methodSchema.fragment = fragment;
              }
            } catch (err) {
              this.logResult(apiDiscoveryUrl, `Fragment request err: ${err}`);
              if (!err.message || err.message.indexOf('AccessDenied') === -1) {
                throw err;
              }
              this.logResult(apiDiscoveryUrl, 'Ignoring error.');
            }
          });
        }
      }
    }
    if (schema.resources) {
      for (const resourceName in schema.resources) {
        // eslint-disable-next-line no-prototype-builtins
        if (schema.resources.hasOwnProperty(resourceName)) {
          this.getFragmentsForSchema(
            apiDiscoveryUrl,
            schema.resources[resourceName],
            apiPath + '.' + resourceName,
            tasks
          );
        }
      }
    }
  }

  /**
   * Generate API file given discovery URL
   * @param apiDiscoveryUri URL or filename of discovery doc for API
   */
  async generateAPI(apiDiscoveryUrl: string) {
    let parts: URL;
    try {
      parts = new URL(apiDiscoveryUrl);
    } catch (e) {
      // 🤷‍♂️
    }
    if (apiDiscoveryUrl && !parts!) {
      this.log(`Reading from file ${apiDiscoveryUrl}`);
      const file = await readFile(apiDiscoveryUrl, 'utf-8');
      await this.generate(apiDiscoveryUrl, JSON.parse(file));
    } else {
      this.logResult(apiDiscoveryUrl, apiDiscoveryUrl);
      const file = await readFile(apiDiscoveryUrl, 'utf8');
      const data = JSON.parse(file) as Schema;
      await this.generate(apiDiscoveryUrl, data);
    }
  }

  private async generate(apiDiscoveryUrl: string, schema: Schema) {
    this.logResult(apiDiscoveryUrl, 'Discovery doc request complete.');
    const tasks = new Array<() => Promise<void>>();
    this.getFragmentsForSchema(
      apiDiscoveryUrl,
      schema,
      `${FRAGMENT_URL}${schema.name}/${schema.version}/0/${schema.name}`,
      tasks
    );

    // e.g. apis/drive/v2.js
    const exportFilename = path.join(
      srcPath,
      'apis',
      schema.name,
      schema.version + '.ts'
    );
    this.logResult(apiDiscoveryUrl, 'Downloading snippets...');
    await Promise.all(tasks.map(t => t()));
    this.logResult(apiDiscoveryUrl, 'Generating APIs...');
    await mkdirp(path.dirname(exportFilename));
    await this.render(API_TEMPLATE, {api: schema}, exportFilename);
    this.logResult(apiDiscoveryUrl, 'Template generation complete.');
    return exportFilename;
  }

  /**
   * Render a nunjucks template, format it, and write to disk
   */
  private async render(templatePath: string, data: {}, outputPath: string) {
    let output = this.env.render(templatePath, data);
    output = prettier.format(output, {
      bracketSpacing: false,
      singleQuote: true,
      trailingComma: 'es5',
      arrowParens: 'avoid',
      parser: 'typescript',
    });
    await writeFile(outputPath, output, {encoding: 'utf8'});
  }
}

/**
 * Build a string used to create a URL from the discovery doc provided URL.
 * replace double slashes with single slash (except in https://)
 * @private
 * @param  input URL to build from
 * @return Resulting built URL
 */
function buildurl(input?: string) {
  return input ? `'${input}'`.replace(/([^:]\/)\/+/g, '$1') : '';
}
