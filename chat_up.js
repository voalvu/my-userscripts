// ==UserScript==
// @name        chat up twitch.tv
// @namespace   Violentmonkey Scripts
// @match       https://www.twitch.tv/*
// @grant       none
// @version     1.0
// @author      -
// @description 10/02/2025, Move the input box to the top of the screen and hide unnecessary element
// ==/UserScript==
(function() {
    'use strict';

    
    const intervalId = setInterval(() => {

        // Optionally, stop the interval if the button is added
        if (document.querySelector('.stream-chat-header')) {
            document.querySelector('.stream-chat-header').insertAdjacentElement('afterend',document.querySelector('.chat-wysiwyg-input__box').parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement)
          document.querySelector('.channel-leaderboard-header-rotating__users').parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.removeChild(document.querySelector('.channel-leaderboard-header-rotating__users').parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement)
          clearInterval(intervalId);
        }

    }, 1000);
})();
