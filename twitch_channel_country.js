// ==UserScript==
// @name         Patch InjectLayout at username for language flag
// @version      0.6
// @description  Patch InjectLayout in 57754-4a7d0281a5a9920008e4.js to log e and e.children.props
// @match        https://www.twitch.tv/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    console.log('Script running - waiting for 57754-4a7d0281a5a9920008e4.js...');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src && node.src.includes('57754-4a7d0281a5a9920008e4.js')) {
                    console.log('Target script detected:', node.src);
                    node.remove(); // Prevent the original from loading
                    patchAndInjectScript(node.src);
                    observer.disconnect(); // Stop observing once we’ve handled it
                }
            });
        });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    function patchAndInjectScript(url) {
        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error('Failed to fetch script');
                return response.text();
            })
            .then(scriptText => {
                // Find the spot to patch
                const anchor = 'i.g)(e),{className:(0,c.cn)(r)});';
                const index = scriptText.indexOf(anchor);
                if (index === -1) {
                    console.log('Anchor point not found in script!');
                    return;
                }

                // Insert the if-else before the `var l = ...`
                const patchPoint = scriptText.lastIndexOf('var l=', index);
                if (patchPoint === -1) {
                    console.log('Couldn’t find "var l =" before the anchor!');
                    return;
                }

                const patchedScript = `
                    ${scriptText.slice(0, patchPoint)}
                    var l;
                    if (e.className === "InjectLayout-sc-1i43xsx-0 dhkijX") {
                        console.log('InjectLayout matched - e:', e);
                        console.log('e.children.props:', e.children.props);
                        console.log(e.children.props.children)
                        e.children.props = {...e.children.props, children:e.children.props.children+" 🇺🇸"}
                        //e.children.props.children = e.children.props.children+🤪;
                        l = (0, n.A)({}, t.props, (0, a.Fh)(e), (0, i.g)(e), { className: (0, c.cn)(r) });
                    } else {
                        l = (0, n.A)({}, t.props, (0, a.Fh)(e), (0, i.g)(e), { className: (0, c.cn)(r) });
                    }
                    ${scriptText.slice(patchPoint + 6)} // Skip original "var l ="
                `;

                // Inject the patched script
                const script = document.createElement('script');
                script.textContent = patchedScript;
                document.head.appendChild(script);
                console.log('Patched script injected!');
            })
            .catch(err => {
                console.error('Error fetching or patching script:', err);
            });
    }
})();
