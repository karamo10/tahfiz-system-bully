// Tahfiz Management System — main.js
// Minimal vanilla JS. No framework.

// Auto-dismiss alerts after 5 seconds
(function() {
  const alerts = document.querySelectorAll('.alert');
  alerts.forEach(function(alert) {
    setTimeout(function() {
      alert.style.transition = 'opacity 0.5s';
      alert.style.opacity    = '0';
      setTimeout(function() { alert.remove(); }, 500);
    }, 5000);
  });
})();
