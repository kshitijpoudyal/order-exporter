(function () {
  'use strict';
  const U = globalThis.SCXUI;
  const $ = (id) => document.getElementById(id);

  async function render() {
    const ok = await U.hasConsent();
    $('agree').classList.toggle('hidden', ok);
    $('withdraw').classList.toggle('hidden', !ok);
    $('state').textContent = ok
      ? 'Enabled. Open your order history on a supported store, then click the extension icon to scan.'
      : '';
  }

  $('agree').addEventListener('click', async () => {
    await U.giveConsent();
    render();
  });
  $('withdraw').addEventListener('click', async () => {
    await U.revokeConsent();
    render();
  });
  render();
})();
