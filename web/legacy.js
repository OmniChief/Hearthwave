/* Classic script: ES3-compatible fallback before the module application loads. */
(function () {
  if (window.location.search.indexOf('modern=1') !== -1) { return; }
  var test = document.createElement('script');
  if (!('noModule' in test) || !window.fetch || !window.Promise || !window.URL || !window.Map) {
    window.location.replace('/tv');
  }
}());
