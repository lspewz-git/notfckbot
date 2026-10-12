/** The last 200 console lines, for the panel's Logs page. Capture starts with the server. */
const logBuffer = [];
let originalLog = null;
let originalError = null;

function startLogCapture() {
    originalLog = console.log;
    originalError = console.error;

    console.log = (...args) => {
        const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'log', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalLog.apply(console, args);
    };

    console.error = (...args) => {
        const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'error', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalError.apply(console, args);
    };
}

module.exports = { logBuffer, startLogCapture };
