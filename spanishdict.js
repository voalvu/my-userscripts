// ==UserScript==
// @name         Auto-Click Button on SpanishDict (SPA Support) and reformatting page layout
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatically clicks a specific button on SpanishDict, even on URL changes in the single-page app.
// @author       Your Name
// @match        https://www.spanishdict.com/*
// @grant        none
// ==/UserScript==
(function() {
    'use strict';

    //const BUTTON_XPATH = '/html/body/div/div/div[1]/div[2]/div[1]/div[4]/div/ul/li[2]/div/a';
    //const BUTTOn_XPATH = '/html/body/div/div/div[1]/div[2]/div[1]/div[5]/div/ul/li[2]/div/a';
  const SELECTORS = {
        remove: ['.OwauVllX', '.TZgqctN1'],
        flex: '._RHBaSfJ',
        width: '.WuDqSfpG',
        participles: { section: '#sd-participles-section', container: '.uVbNQIMZ' },
        click: "a[href='/conjugate/construir']"
    };

    const clickButton = () => {
        const button = document.querySelector(SELECTORS.click);
        if (button) button.click();
    };

    const cleanAndFormatPage = () => {
        SELECTORS.remove.forEach(selector => document.querySelector(selector)?.remove());
        document.querySelector(SELECTORS.flex)?.style.setProperty('display', 'flex');
        document.querySelector(SELECTORS.width)?.style.setProperty('width', 'auto');

        const participlesSection = document.querySelector(SELECTORS.participles.section);
        const participlesContainer = document.querySelector(SELECTORS.participles.container);
        if (participlesSection && participlesContainer && !participlesContainer.contains(participlesSection)) {
            participlesContainer.appendChild(participlesSection);
            participlesContainer.style.gridTemplateColumns = '1fr auto auto';
        }
    };

    const observer = new MutationObserver(() => {
        clickButton();
        cleanAndFormatPage();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    clickButton();
})();
