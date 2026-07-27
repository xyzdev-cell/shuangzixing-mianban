(function () {
    function translate(key) {
        return window.t ? window.t(key) : key;
    }

    /**
     * Compares two semantic version strings.
     * @param {string} v1 - The first version string.
     * @param {string} v2 - The second version string.
     * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2.
     */
    function compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        const len = Math.max(parts1.length, parts2.length);

        for (let i = 0; i < len; i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    async function checkForUpdates() {
        try {
            const localVersionResponse = await fetch('/admin/version.txt?t=' + new Date().getTime());
            if (!localVersionResponse.ok) {
                console.warn('Could not fetch local version.txt');
                return;
            }
            const localVersion = (await localVersionResponse.text()).trim();

            const githubApiResponse = await fetch('https://api.github.com/repos/dreamhartley/gemini-proxy-panel/releases/latest');
            if (!githubApiResponse.ok) {
                console.warn('Could not fetch latest release from GitHub.');
                showVersionDisplay(localVersion);
                return;
            }
            const latestRelease = await githubApiResponse.json();
            const latestVersion = latestRelease.tag_name.replace('v', '').trim();

            const updateNotifier = document.getElementById('update-notifier');
            if (!updateNotifier) return;

            if (compareVersions(latestVersion, localVersion) > 0) {
                updateNotifier.classList.remove('hidden', 'version-display');
                updateNotifier.textContent = 'New';
                updateNotifier.setAttribute('data-tooltip', translate('update_available'));
                updateNotifier.removeAttribute('title');
            } else {
                showVersionDisplay(localVersion);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
            try {
                const localVersionResponse = await fetch('/admin/version.txt?t=' + new Date().getTime());
                if (localVersionResponse.ok) {
                    const localVersion = (await localVersionResponse.text()).trim();
                    showVersionDisplay(localVersion);
                }
            } catch (versionError) {
                console.error('Error fetching local version:', versionError);
            }
        }
    }

    function showVersionDisplay(version) {
        const updateNotifier = document.getElementById('update-notifier');
        if (updateNotifier) {
            updateNotifier.classList.remove('hidden');
            updateNotifier.classList.add('version-display');
            updateNotifier.textContent = `v${version}`;
            updateNotifier.setAttribute('data-tooltip', translate('current_is_latest'));
            updateNotifier.removeAttribute('title');
        }
    }

    window.compareVersions = compareVersions;
    window.checkForUpdates = checkForUpdates;
    window.showVersionDisplay = showVersionDisplay;

    window.show = function (what) {
        if (what === 'update') {
            const updateNotifier = document.getElementById('update-notifier');
            if (updateNotifier) {
                updateNotifier.classList.remove('hidden', 'version-display');
                updateNotifier.textContent = 'New';
                updateNotifier.setAttribute('data-tooltip', translate('update_available'));
                updateNotifier.removeAttribute('title');
                console.log("Debug: Forcibly showing update notifier.");
                return "Update notifier shown.";
            }

            const msg = "Debug Error: #update-notifier element not found.";
            console.error(msg);
            return msg;
        }

        if (what === 'version') {
            const updateNotifier = document.getElementById('update-notifier');
            if (updateNotifier) {
                showVersionDisplay('1.2.0');
                console.log("Debug: Forcibly showing version display.");
                return "Version display shown.";
            }

            const msg = "Debug Error: #update-notifier element not found.";
            console.error(msg);
            return msg;
        }

        return `Unknown command: ${what}`;
    };
})();

