/* Select a server-rendered UI before any unsupported module is executed. */
(function () {
  var candidate = document.createElement('script');
  if (window.location.search.indexOf('modern=1') >= 0) { return; }
  if (!('noModule' in candidate) || !window.fetch || !window.Promise || !window.URL || !window.Map || !window.Set) {
    window.location.replace('/tv');
  }
}());
