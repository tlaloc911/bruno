import each from 'lodash/each';
import get from 'lodash/get';
import jsyaml from 'js-yaml';
import { validateSchema, transformItemsInCollection, hydrateSeqInCollection, uuid } from '../common';

const ensureUrl = (url) => {
  // removing multiple slashes after the protocol if it exists, or after the beginning of the string otherwise
  return url.replace(/([^:])\/{2,}/g, '$1/');
};

const buildEmptyJsonBody = (bodySchema, visited = new Map()) => {
  // Check for circular references
  if (visited.has(bodySchema)) {
    return {};
  }

  // Add this schema to visited map
  visited.set(bodySchema, true);

  let _jsonBody = {};
  each(bodySchema.properties || {}, (prop, name) => {
    if (prop.type === 'object') {
      _jsonBody[name] = buildEmptyJsonBody(prop, visited);
    } else if (prop.type === 'array') {
      if (prop.items && prop.items.type === 'object') {
        _jsonBody[name] = [buildEmptyJsonBody(prop.items, visited)];
      } else {
        _jsonBody[name] = [];
      }
    } else if (prop.type === 'integer') {
      _jsonBody[name] = 0;
    } else if (prop.type === 'boolean') {
      _jsonBody[name] = false;
    } else {
      _jsonBody[name] = '';
    }
  });
  return _jsonBody;
};

const transformOpenapiRequestItem = (request) => {
  let _operationObject = request.operationObject;

  let operationName = _operationObject.summary || _operationObject.operationId || _operationObject.description;
  if (!operationName) {
    operationName = `${request.method} ${request.path}`;
  }

  // replace OpenAPI links in path by Bruno variables
  let path = request.path.replace(/{([a-zA-Z]+)}/g, `{{${_operationObject.operationId}_$1}}`);

  const brunoRequestItem = {
    uid: uuid(),
    name: operationName,
    type: 'http-request',
    request: {
      url: ensureUrl(request.global.server + path),
      method: request.method.toUpperCase(),
      auth: {
        mode: 'none',
        basic: null,
        bearer: null,
        digest: null
      },
      headers: [],
      params: [],
      body: {
        mode: 'none',
        json: null,
        text: null,
        xml: null,
        formUrlEncoded: [],
        multipartForm: []
      },
      script: {
        res: null
      }
    }
  };

  each(_operationObject.parameters || [], (param) => {
    if (param.in === 'query') {
      brunoRequestItem.request.params.push({
        uid: uuid(),
        name: param.name,
        value: '',
        description: param.description || '',
        enabled: param.required,
        type: 'query'
      });
    } else if (param.in === 'path') {
      brunoRequestItem.request.params.push({
        uid: uuid(),
        name: param.name,
        value: '',
        description: param.description || '',
        enabled: param.required,
        type: 'path'
      });
    } else if (param.in === 'header') {
      brunoRequestItem.request.headers.push({
        uid: uuid(),
        name: param.name,
        value: '',
        description: param.description || '',
        enabled: param.required
      });
    }
  });

  let auth;
  // allow operation override
  if (_operationObject.security && _operationObject.security.length > 0) {
    let schemeName = Object.keys(_operationObject.security[0])[0];
    auth = request.global.security.getScheme(schemeName);
  } else if (request.global.security.supported.length > 0) {
    auth = request.global.security.supported[0];
  }

  if (auth) {
    if (auth.type === 'http' && auth.scheme === 'basic') {
      brunoRequestItem.request.auth.mode = 'basic';
      brunoRequestItem.request.auth.basic = {
        username: '{{username}}',
        password: '{{password}}'
      };
    } else if (auth.type === 'http' && auth.scheme === 'bearer') {
      brunoRequestItem.request.auth.mode = 'bearer';
      brunoRequestItem.request.auth.bearer = {
        token: '{{token}}'
      };
    } else if (auth.type === 'apiKey' && auth.in === 'header') {
      brunoRequestItem.request.headers.push({
        uid: uuid(),
        name: auth.name,
        value: '{{apiKey}}',
        description: 'Authentication header',
        enabled: true
      });
    }
  }

  // TODO: handle allOf/anyOf/oneOf
  if (_operationObject.requestBody) {
    let content = get(_operationObject, 'requestBody.content', {});
    let mimeType = Object.keys(content)[0];
    let body = content[mimeType] || {};
    let bodySchema = body.schema;
    if (mimeType === 'application/json') {
      brunoRequestItem.request.body.mode = 'json';
      if (bodySchema && bodySchema.type === 'object') {
        let _jsonBody = buildEmptyJsonBody(bodySchema);
        brunoRequestItem.request.body.json = JSON.stringify(_jsonBody, null, 2);
      }
      if (bodySchema && bodySchema.type === 'array') {
        brunoRequestItem.request.body.json = JSON.stringify([buildEmptyJsonBody(bodySchema.items)], null, 2);
      }
    } else if (mimeType === 'application/x-www-form-urlencoded') {
      brunoRequestItem.request.body.mode = 'formUrlEncoded';
      if (bodySchema && bodySchema.type === 'object') {
        each(bodySchema.properties || {}, (prop, name) => {
          brunoRequestItem.request.body.formUrlEncoded.push({
            uid: uuid(),
            name: name,
            value: '',
            description: prop.description || '',
            enabled: true
          });
        });
      }
    } else if (mimeType === 'multipart/form-data') {
      brunoRequestItem.request.body.mode = 'multipartForm';
      if (bodySchema && bodySchema.type === 'object') {
        each(bodySchema.properties || {}, (prop, name) => {
          brunoRequestItem.request.body.multipartForm.push({
            uid: uuid(),
            type: 'text',
            name: name,
            value: '',
            description: prop.description || '',
            enabled: true
          });
        });
      }
    } else if (mimeType === 'text/plain') {
      brunoRequestItem.request.body.mode = 'text';
      brunoRequestItem.request.body.text = '';
    } else if (mimeType === 'text/xml') {
      brunoRequestItem.request.body.mode = 'xml';
      brunoRequestItem.request.body.xml = '';
    }
  }

  // build the extraction scripts from responses that have links
  // https://swagger.io/docs/specification/links/
  let script = [];
  each(_operationObject.responses || [], (response, responseStatus) => {
    if (Object.hasOwn(response, 'links')) {
      // only extract if the status code matches the response
      script.push(`if (res.status === ${responseStatus}) {`);
      each(response.links, (link) => {
        each(link.parameters || [], (expression, parameter) => {
          let value = openAPIRuntimeExpressionToScript(expression);
          script.push(`  bru.setVar('${link.operationId}_${parameter}', ${value});`);
        });
      });
      script.push(`}`);
    }
  });
  if (script.length > 0) {
    brunoRequestItem.request.script.res = script.join('\n');
  }

  return brunoRequestItem;
};

const resolveRefs = (spec, components = spec?.components, cache = new Map()) => {
  if (!spec || typeof spec !== 'object') {
    return spec;
  }

  if (cache.has(spec)) {
    return cache.get(spec);
  }

  if (Array.isArray(spec)) {
    return spec.map(item => resolveRefs(item, components, cache));
  }

  if ('$ref' in spec) {
    const refPath = spec.$ref;

    if (cache.has(refPath)) {
      return cache.get(refPath);
    }

    if (refPath.startsWith('#/components/')) {
      const refKeys = refPath.replace('#/components/', '').split('/');
      let ref = components;

      for (const key of refKeys) {
        if (ref && ref[key]) {
          ref = ref[key];
        } else {
          return spec;
        }
      }

      cache.set(refPath, {});
      const resolved = resolveRefs(ref, components, cache);
      cache.set(refPath, resolved);
      return resolved;
    }
    return spec;
  }

  const resolved = {};
  cache.set(spec, resolved);

  for (const [key, value] of Object.entries(spec)) {
    resolved[key] = resolveRefs(value, components, cache);
  }

  return resolved;
};

const groupRequestsByTags = (requests) => {
  let _groups = {};
  let ungrouped = [];
  each(requests, (request) => {
    let tags = request.operationObject.tags || [];
    if (tags.length > 0) {
      let tag = tags[0].trim(); // take first tag and trim whitespace

      if (tag) {
        if (!_groups[tag]) {
          _groups[tag] = [];
        }
        _groups[tag].push(request);
      } else {
        ungrouped.push(request);
      }
    } else {
      ungrouped.push(request);
    }
  });

  let groups = Object.keys(_groups).map((groupName) => {
    return {
      name: groupName,
      requests: _groups[groupName]
    };
  });

  return [groups, ungrouped];
};

const getDefaultUrl = (serverObject) => {
  let url = serverObject.url;
  if (serverObject.variables) {
    each(serverObject.variables, (variable, variableName) => {
      let sub = variable.default || (variable.enum ? variable.enum[0] : `{{${variableName}}}`);
      url = url.replace(`{${variableName}}`, sub);
    });
  }
  return url.endsWith('/') ? url.slice(0, -1) : url;
};

const getSecurity = (apiSpec) => {
  let defaultSchemes = apiSpec.security || [];

  let securitySchemes = get(apiSpec, 'components.securitySchemes', {});
  if (Object.keys(securitySchemes) === 0) {
    return {
      supported: []
    };
  }

  return {
    supported: defaultSchemes.map((scheme) => {
      var schemeName = Object.keys(scheme)[0];
      return securitySchemes[schemeName];
    }),
    schemes: securitySchemes,
    getScheme: (schemeName) => {
      return securitySchemes[schemeName];
    }
  };
};

const openAPIRuntimeExpressionToScript = (expression) => {
  // see https://swagger.io/docs/specification/links/#runtime-expressions
  if (expression === '$response.body') {
    return 'res.body';
  } else if (expression.startsWith('$response.body#')) {
    let pointer = expression.substring(15);
    // could use https://www.npmjs.com/package/json-pointer for better support
    return `res.body${pointer.replace('/', '.')}`;
  }
  return expression;
};

export const parseOpenApiCollection = (data) => {
  const brunoCollection = {
    name: '',
    uid: uuid(),
    version: '1',
    items: [],
    environments: []
  };
    try {
      const collectionData = resolveRefs(data);
      if (!collectionData) {
        throw new Error('Invalid OpenAPI collection. Failed to resolve refs.');
        return;
      }

      // Currently parsing of openapi spec is "do your best", that is
      // allows "invalid" openapi spec

      // Assumes v3 if not defined. v2 is not supported yet
      if (collectionData.openapi && !collectionData.openapi.startsWith('3')) {
        throw new Error('Only OpenAPI v3 is supported currently.');
        return;
      }

      brunoCollection.name = collectionData.info?.title?.trim() || 'Untitled Collection';

      let servers = collectionData.servers || [];

      // Create environments based on the servers
      servers.forEach((server, index) => {
        let baseUrl = getDefaultUrl(server);
        let environmentName = server.description ? server.description : `Environment ${index + 1}`;

        brunoCollection.environments.push({
          uid: uuid(),
          name: environmentName,
          variables: [
            {
              uid: uuid(),
              name: 'baseUrl',
              value: baseUrl,
              type: 'text',
              enabled: true,
              secret: false
            },
          ]
        });
      });

      let securityConfig = getSecurity(collectionData);

      let allRequests = Object.entries(collectionData.paths)
        .map(([path, methods]) => {
          return Object.entries(methods)
            .filter(([method, op]) => {
              return ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(
                method.toLowerCase()
              );
            })
            .map(([method, operationObject]) => {
              return {
                method: method,
                path: path.replace(/{([^}]+)}/g, ':$1'), // Replace placeholders enclosed in curly braces with colons
                operationObject: operationObject,
                global: {
                  server: '{{baseUrl}}', 
                  security: securityConfig
                }
              };
            });
        })
        .reduce((acc, val) => acc.concat(val), []); // flatten

      let [groups, ungroupedRequests] = groupRequestsByTags(allRequests);
      let brunoFolders = groups.map((group) => {
        return {
          uid: uuid(),
          name: group.name,
          type: 'folder',
          items: group.requests.map(transformOpenapiRequestItem)
        };
      });

      let ungroupedItems = ungroupedRequests.map(transformOpenapiRequestItem);
      let brunoCollectionItems = brunoFolders.concat(ungroupedItems);
      brunoCollection.items = brunoCollectionItems;
      return brunoCollection;
    } catch (err) {
      if (!(err instanceof Error)) {
        throw new Error('Unknown error');
      }
      throw err;
    }
};

export const openApiToBruno = (openApiSpecification) => {
  try {
    if(typeof openApiSpecification !== 'object') {
      openApiSpecification = jsyaml.load(openApiSpecification);
    }

    const collection = parseOpenApiCollection(openApiSpecification);
    const transformedCollection = transformItemsInCollection(collection);
    const hydratedCollection = hydrateSeqInCollection(transformedCollection);
    const validatedCollection = validateSchema(hydratedCollection);
    return validatedCollection
  } catch (err) {
    console.error('Error converting OpenAPI to Bruno:', err);
    if (!(err instanceof Error)) {
      throw new Error('Unknown error');
    }
    throw err;
  }
};

export default openApiToBruno;
