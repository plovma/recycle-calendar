#!/usr/bin/env node

/*
 * Requires Node.js 20 or newer.
 *
 * Examples:
 *   node generate-calendar.js
 *   node generate-calendar.js --url https://example/graphql --sha256Hash <hash>
 *   node generate-calendar.js --output calendar.ics --html-output calendar.html --perPage 50
 *
 * The URL and hash can also be set with MATCHES_URL and MATCHES_SHA256_HASH.
 */

const fs = require("node:fs/promises");

const DEFAULT_URL = "https://d2e3twic1m8a2a.cloudfront.net/graphql";
const DEFAULT_OUTPUT = "./public/calendar.ics";
const DEFAULT_HTML_OUTPUT = "./public/calendar.html";

