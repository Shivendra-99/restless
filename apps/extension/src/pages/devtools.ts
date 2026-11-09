// Runs whenever DevTools opens; adds the Restless tab. Capture starts when that tab is first shown.
chrome.devtools.panels.create('Restless', 'icons/icon-32.png', 'panel.html');
