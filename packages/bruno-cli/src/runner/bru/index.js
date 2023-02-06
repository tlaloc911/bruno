const _ = require('lodash');
const {
  bruToJsonV2
} = require('@usebruno/lang');

/**
 * The transformer function for converting a BRU file to JSON.
 * 
 * We map the json response from the bru lang and transform it into the DSL
 * format that is used by the bruno app
 * 
 * @param {string} bru The BRU file content.
 * @returns {object} The JSON representation of the BRU file.
 */
const bruToJson = (bru) => {
  try {
    const json = bruToJsonV2(bru);

    let requestType = _.get(json, "meta.type");
    if(requestType === "http") {
      requestType = "http-request"
    } else if(requestType === "graphql") {
      requestType = "graphql-request";
    } else {
      requestType = "http";
    }

    const sequence = _.get(json, "meta.seq")

    const transformedJson = {
      "type": requestType,
      "name": _.get(json, "meta.name"),
      "seq": !isNaN(sequence) ? Number(sequence) : 1,
      "request": {
        "method": _.upperCase(_.get(json, "http.method")),
        "url": _.get(json, "http.url"),
        "params": _.get(json, "query", []),
        "headers":  _.get(json, "headers", []),
        "body":  _.get(json, "body", {}),
        "vars": _.get(json, "vars", []),
        "assert": _.get(json, "assert", []),
        "script": _.get(json, "script", ""),
        "tests": _.get(json, "tests", "")
      }
    };

    transformedJson.request.body.mode = _.get(json, "http.mode", "none");

    return transformedJson;
  } catch (err) {
    return Promise.reject(err);
  }
};

module.exports = {
  bruToJson
};