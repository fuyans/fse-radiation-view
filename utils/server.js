#!/usr/bin/env node
/**
 * Static HTTP server for the Radiation Heat Transfer Editor.
 * Serves from the repository root so editor/, examples/, and files/ are available.
 *
 * Usage: node utils/server.js [-p port]
 * Default port: 8080
 *
 * Open http://localhost:8080/editor/ to use the editor.
 *
 * When deployed with a single-file build: if editor/dist/index.single.html exists,
 * GET /editor/ serves that file so the app runs from the single bundle. Build with:
 *   npm run build-single:no-obfuscate
 * (or npm run build-single for obfuscated). Then set EDITOR_URL to
 * http://your-host:8080/editor/ (trailing slash).
 */

const http = require( 'http' );
const https = require( 'https' );
const fs = require( 'fs' );
const path = require( 'path' );

const ROOT = path.join( __dirname, '..' );

// ---------------------------------------------------------------------------
// Proxy configuration
// Set COMPUTE_SERVER_URL env var or pass -u <url> to enable proxy mode.
// When enabled: /api/* requests are forwarded to the compute server,
// and the editor HTML is served with window.__serverConfig injected so the
// UI automatically hides the server-URL input field.
// ---------------------------------------------------------------------------

function getComputeServerUrl() {

	for ( let i = 0; i < process.argv.length; i ++ ) {
		if ( process.argv[ i ] === '-u' && process.argv[ i + 1 ] ) {
			return process.argv[ i + 1 ].replace( /\/$/, '' );
		}
	}
	if ( process.env.COMPUTE_SERVER_URL ) {
		return process.env.COMPUTE_SERVER_URL.replace( /\/$/, '' );
	}
	return null;

}

const COMPUTE_SERVER_URL = getComputeServerUrl();
const PROXY_CONFIG_SCRIPT = COMPUTE_SERVER_URL
	? `<script>window.__serverConfig = ${JSON.stringify( { proxyEnabled: true } )};</script>`
	: null;

// Cache injected HTML so the 5 MB bundle is only patched once per process.
const _htmlInjectionCache = new Map();

const MIME = {
	'.html': 'text/html',
	'.htm': 'text/html',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.cjs': 'application/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.ico': 'image/x-icon',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.wasm': 'application/wasm',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.md': 'text/markdown'
};

/**
 * Resolve a URL pathname to a filesystem path.
 * Tries the dist/ (bundled) copy first, then falls back to the source location.
 * This lets the server work in both dev mode (source files) and deployed mode
 * (pre-built dist/ with single-file bundle).
 */
function remapBundledAssetPath(pathname) {

	// /editor/images/* and /editor/examples/* are copied into dist/ during build.
	// Try dist first, but fall back to the source tree when dist is empty.
	if (pathname.startsWith('/editor/images/') || pathname.startsWith('/editor/examples/')) {
		const distPath = path.join(ROOT, 'editor', 'dist', pathname.slice('/editor'.length));
		if (fs.existsSync(distPath)) return distPath;
		return path.join(ROOT, pathname);
	}

	// /images/* and /examples/* at the root level always come from the source tree.
	// (The bundled index.single.html inlines all assets, so these requests only
	// happen in dev mode.)
	return path.join(ROOT, pathname);

}

function getPort() {

	let port = 8080;
	for ( let i = 0; i < process.argv.length; i ++ ) {
		if ( process.argv[ i ] === '-p' && process.argv[ i + 1 ] ) {
			port = parseInt( process.argv[ i + 1 ], 10 ) || port;
		}
	}
	return port;

}

function getMime( ext ) {

	return MIME[ ext.toLowerCase() ] || 'application/octet-stream';

}

/**
 * Forward /api/* requests to COMPUTE_SERVER_URL.
 * Streams the response back (handles plain JSON and SSE alike).
 */
function proxyToCompute( req, res ) {

	const target = new URL( COMPUTE_SERVER_URL );
	const isHttps = target.protocol === 'https:';
	const transport = isHttps ? https : http;

	const reqUrl = new URL( req.url, 'http://localhost' );
	const proxyPath = reqUrl.pathname + ( reqUrl.search || '' );

	const options = {
		hostname: target.hostname,
		port: target.port || ( isHttps ? 443 : 80 ),
		path: proxyPath,
		method: req.method,
		headers: Object.assign( {}, req.headers, { host: target.host } )
	};

	const proxyReq = transport.request( options, ( proxyRes ) => {

		const headers = Object.assign( {}, proxyRes.headers );
		// Remove content-length for streaming responses (SSE) so Node doesn't
		// close the connection before the stream ends.
		const ct = headers[ 'content-type' ] || '';
		if ( ct.includes( 'text/event-stream' ) ) {
			delete headers[ 'content-length' ];
			headers[ 'cache-control' ] = 'no-cache';
		}

		res.writeHead( proxyRes.statusCode, headers );
		proxyRes.pipe( res );
		req.on( 'close', () => proxyRes.destroy() );

	} );

	proxyReq.on( 'error', ( err ) => {

		console.error( 'Proxy error:', err.message );
		if ( ! res.headersSent ) {
			res.writeHead( 502 );
			res.end( 'Bad Gateway: ' + err.message );
		}

	} );

	req.pipe( proxyReq );

}

const server = http.createServer( ( req, res ) => {

	let requestUrl;
	let pathname;
	try {
		// Use WHATWG URL API (Node deprecates legacy url.parse()).
		requestUrl = new URL( req.url, 'http://localhost' );
		pathname = requestUrl.pathname;
	} catch ( err ) {
		res.writeHead( 400 );
		res.end( 'Bad Request' );
		return;
	}

	// ---------------------------------------------------------------------------
	// /api/config — advertise proxy capability to the editor
	// ---------------------------------------------------------------------------
	if ( pathname === '/api/config' ) {
		const body = JSON.stringify( { proxyEnabled: !! COMPUTE_SERVER_URL } );
		res.writeHead( 200, { 'Content-Type': 'application/json' } );
		res.end( body );
		return;
	}

	// ---------------------------------------------------------------------------
	// /api/telemetry — accept startup pings and solve events from the Electron app
	// ---------------------------------------------------------------------------
	if ( pathname === '/api/telemetry' && req.method === 'POST' ) {
		readBody( req, ( body ) => {
			try {
				const data = JSON.parse( body );
				const logLine = JSON.stringify( {
					timestamp: new Date().toISOString(),
					...data
				} ) + '\n';
				appendToLog( 'telemetry.log', logLine );
				console.log( '[telemetry]', data.event || 'unknown', data.appVersion, data.installId );
			} catch ( err ) {
				console.error( '[telemetry] parse error:', err.message );
			}
			res.writeHead( 200, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( { ok: true } ) );
		} );
		return;
	}

	// ---------------------------------------------------------------------------
	// /api/crash-report — accept crash reports from the Electron app
	// ---------------------------------------------------------------------------
	if ( pathname === '/api/crash-report' && req.method === 'POST' ) {
		readBody( req, ( body ) => {
			try {
				const data = JSON.parse( body );
				const logLine = JSON.stringify( {
					timestamp: new Date().toISOString(),
					...data
				} ) + '\n';
				appendToLog( 'crash-report.log', logLine );
				console.error( '[crash-report]', data.type, data.reason, data.appVersion, data.installId );
			} catch ( err ) {
				console.error( '[crash-report] parse error:', err.message );
			}
			res.writeHead( 200, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( { ok: true } ) );
		} );
		return;
	}

	// ---------------------------------------------------------------------------
	// /api/* — proxy to compute server (only when proxy is configured)
	// ---------------------------------------------------------------------------
	if ( COMPUTE_SERVER_URL && pathname.startsWith( '/api/' ) ) {
		proxyToCompute( req, res );
		return;
	}

	// Redirect / to /editor/
	if ( pathname === '/' ) {
		res.writeHead( 302, { Location: '/editor/' } );
		res.end();
		return;
	}

	const filePath = remapBundledAssetPath(pathname);

	// Prevent directory traversal
	const normalized = path.normalize( filePath );
	if ( ! normalized.startsWith( ROOT ) ) {
		res.writeHead( 403 );
		res.end( 'Forbidden' );
		return;
	}

	fs.stat( filePath, ( err, stat ) => {

		if ( err ) {
			if ( err.code === 'ENOENT' ) {
				console.warn(`[404] ${req.method} ${pathname}`);
				res.writeHead( 404 );
				res.end( 'Not Found' );
			} else {
				console.error(`[500] ${req.method} ${pathname}: ${err.code || err.message}`);
				res.writeHead( 500 );
				res.end( 'Server Error' );
			}
			return;
		}

		if ( stat.isDirectory() ) {
			// Canonicalize directory URLs so relative asset paths resolve correctly.
			// This is especially important for /editor when serving index.single.html,
			// because the bundle still loads examples/ and images/ relatively.
			if ( ! pathname.endsWith( '/' ) ) {
				res.writeHead( 302, { Location: pathname + '/' + requestUrl.search } );
				res.end();
				return;
			}

			// Prefer single-file build for /editor/ when deployed (editor/dist/index.single.html)
			const singlePath = path.join( ROOT, 'editor', 'dist', 'index.single.html' );
			const isEditorDir = pathname === '/editor' || pathname === '/editor/';
			const index = path.join( filePath, 'index.html' );
			if ( isEditorDir && singlePath.startsWith( ROOT ) ) {
				fs.stat( singlePath, ( errSingle, statSingle ) => {
					if ( ! errSingle && statSingle.isFile() ) {
						serveFile( singlePath, res );
						return;
					}
					fallbackToIndex();
				} );
			} else {
				fallbackToIndex();
			}
			function fallbackToIndex() {
				fs.stat( index, ( errIndex, statIndex ) => {
					if ( ! errIndex && statIndex.isFile() ) {
						serveFile( index, res );
					} else {
						res.writeHead( 403 );
						res.end( 'Forbidden' );
					}
				} );
			}
			return;
		}

		serveFile( filePath, res );

	} );

} );

function serveFile( filePath, res ) {

	const ext = path.extname( filePath );
	const mime = getMime( ext );

	// Inject window.__serverConfig into HTML responses when proxy mode is active.
	if ( PROXY_CONFIG_SCRIPT && ( ext === '.html' || ext === '.htm' ) ) {
		serveHtmlWithInjection( filePath, mime, res );
		return;
	}

	const stream = fs.createReadStream( filePath );

	stream.on( 'error', () => {
		res.writeHead( 500 );
		res.end( 'Server Error' );
	} );

	res.writeHead( 200, { 'Content-Type': mime } );
	stream.pipe( res );

}

function serveHtmlWithInjection( filePath, mime, res ) {

	if ( _htmlInjectionCache.has( filePath ) ) {
		res.writeHead( 200, { 'Content-Type': mime } );
		res.end( _htmlInjectionCache.get( filePath ) );
		return;
	}

	fs.readFile( filePath, 'utf8', ( err, content ) => {

		if ( err ) {
			res.writeHead( 500 );
			res.end( 'Server Error' );
			return;
		}

		const injected = content.includes( '</head>' )
			? content.replace( '</head>', PROXY_CONFIG_SCRIPT + '\n</head>' )
			: PROXY_CONFIG_SCRIPT + '\n' + content;

		_htmlInjectionCache.set( filePath, injected );
		res.writeHead( 200, { 'Content-Type': mime } );
		res.end( injected );

	} );

}

// ---------------------------------------------------------------------------
// Helpers for telemetry / crash-report POST endpoints
// ---------------------------------------------------------------------------
function readBody( req, callback ) {

	let body = '';
	req.on( 'data', ( chunk ) => { body += chunk; } );
	req.on( 'end', () => { callback( body ); } );
	req.on( 'error', () => { callback( '' ); } );

}

function appendToLog( filename, line ) {

	const logPath = path.join( ROOT, 'logs', filename );
	fs.mkdir( path.dirname( logPath ), { recursive: true }, () => {
		fs.appendFile( logPath, line, () => {} );
	} );

}

const port = getPort();
server.on( 'error', ( err ) => {
	if ( err.code === 'EADDRINUSE' ) {
		console.error( `Port ${port} is already in use. Stop the other process or use another port:` );
		console.error( `  npm start -- -p 8081` );
		console.error( `  Or find and kill the process: lsof -i :${port}` );
	} else {
		console.error( err );
	}
	process.exit( 1 );
} );
server.listen( port, '0.0.0.0', () => {
	console.log( `Editor server: http://localhost:${port}/` );
	console.log( `  Editor UI:  http://localhost:${port}/editor/` );
	if ( COMPUTE_SERVER_URL ) {
		console.log( `  Proxy:      /api/* → ${COMPUTE_SERVER_URL}` );
	} else {
		console.log( `  Proxy:      disabled  (set COMPUTE_SERVER_URL or use -u <url> to enable)` );
	}
} );
