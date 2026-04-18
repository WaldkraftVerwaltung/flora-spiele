// Kill-Switch für den alten Ballongarten-SW, der mit Scope / installiert war.
// Ballongarten lebt jetzt unter /ballongarten/ mit eigenem SW. Nutzer, die die
// alte Version noch auf dem Handy haben, bekommen hier einen SW ohne
// Fetch-Handler — Browser-Navigation geht dann wieder direkt ans Netzwerk.
// Zusätzlich werden die alten Caches gelöscht und die Registrierung entfernt,
// damit die veraltete Zuordnung sauber verschwindet.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Alle Caches, die der alte SW angelegt hatte, wegwerfen
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // Diese Registrierung komplett abmelden
    await self.registration.unregister();
    // Offene Tabs neu laden, damit sie ohne SW frisch vom Server kommen
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => { try { c.navigate(c.url); } catch {} });
  })());
});
