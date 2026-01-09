// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;

    // Skip processing if already in /proxy/... format (for S3 direct access and redirects)
    if (request.uri.indexOf('/proxy/') === 0) {
        return request;
    }

    // Check if 'url' query parameter exists
    if (!request.querystring || !request.querystring.url || !request.querystring.url.value) {
        return {
            statusCode: 400,
            statusDescription: 'Bad Request',
            body: 'Missing required parameter: url'
        };
    }

    var imageUrl = request.querystring.url.value;

    // Validate URL format (basic check)
    if (!imageUrl.match(/^https?:\/\/.+/i)) {
        return {
            statusCode: 400,
            statusDescription: 'Bad Request',
            body: 'Invalid URL format'
        };
    }

    // Custom base64 encoding for CloudFront Functions (no btoa available)
    function base64Encode(str) {
        var base64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var result = '';
        var i = 0;

        while (i < str.length) {
            var startPos = i;
            var a = str.charCodeAt(i++);
            var b = i < str.length ? str.charCodeAt(i++) : 0;
            var c = i < str.length ? str.charCodeAt(i++) : 0;

            var charsRead = i - startPos;
            var bitmap = (a << 16) | (b << 8) | c;

            result += base64chars.charAt((bitmap >> 18) & 63);
            result += base64chars.charAt((bitmap >> 12) & 63);
            result += charsRead > 1 ? base64chars.charAt((bitmap >> 6) & 63) : '=';
            result += charsRead > 2 ? base64chars.charAt(bitmap & 63) : '=';
        }

        return result;
    }

    // Encode URL to base64url (URL-safe base64)
    var encodedUrl = base64Encode(imageUrl)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    // Process transformation parameters
    var normalizedOperations = {};
    var keys = Object.keys(request.querystring);

    for (var i = 0; i < keys.length; i++) {
        var operation = keys[i];
        if (operation === 'url') continue; // Skip the url parameter

        var opLower = operation.toLowerCase();

        if (opLower === 'format') {
            var SUPPORTED_FORMATS = ['auto', 'jpeg', 'webp', 'avif', 'png', 'svg', 'gif'];
            if (request.querystring[operation]['value']) {
                var formatValue = request.querystring[operation]['value'].toLowerCase();
                var formatFound = false;
                for (var j = 0; j < SUPPORTED_FORMATS.length; j++) {
                    if (SUPPORTED_FORMATS[j] === formatValue) {
                        formatFound = true;
                        break;
                    }
                }
                if (formatFound) {
                    var format = formatValue;
                    if (format === 'auto') {
                        format = 'jpeg';
                        if (request.headers && request.headers['accept']) {
                            var acceptValue = request.headers['accept'].value;
                            if (acceptValue.indexOf("avif") !== -1) {
                                format = 'avif';
                            } else if (acceptValue.indexOf("webp") !== -1) {
                                format = 'webp';
                            }
                        }
                    }
                    normalizedOperations['format'] = format;
                }
            }
        } else if (opLower === 'width') {
            if (request.querystring[operation]['value']) {
                var width = parseInt(request.querystring[operation]['value']);
                if (!isNaN(width) && width > 0 && width <= 4000) {
                    normalizedOperations['width'] = width.toString();
                }
            }
        } else if (opLower === 'height') {
            if (request.querystring[operation]['value']) {
                var height = parseInt(request.querystring[operation]['value']);
                if (!isNaN(height) && height > 0 && height <= 4000) {
                    normalizedOperations['height'] = height.toString();
                }
            }
        } else if (opLower === 'quality') {
            if (request.querystring[operation]['value']) {
                var quality = parseInt(request.querystring[operation]['value']);
                if (!isNaN(quality) && quality > 0) {
                    if (quality > 100) quality = 100;
                    normalizedOperations['quality'] = quality.toString();
                }
            }
        }
    }

    // Build new path
    var operationsSuffix = 'original';
    if (Object.keys(normalizedOperations).length > 0) {
        var normalizedOperationsArray = [];
        if (normalizedOperations['format']) normalizedOperationsArray.push('format=' + normalizedOperations['format']);
        if (normalizedOperations['quality']) normalizedOperationsArray.push('quality=' + normalizedOperations['quality']);
        if (normalizedOperations['width']) normalizedOperationsArray.push('width=' + normalizedOperations['width']);
        if (normalizedOperations['height']) normalizedOperationsArray.push('height=' + normalizedOperations['height']);
        operationsSuffix = normalizedOperationsArray.join(',');
    }

    request.uri = '/proxy/' + encodedUrl + '/' + operationsSuffix;
    request.querystring = {};

    return request;
}
