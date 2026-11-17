# Conturi Google (web)

Pagină web statică pentru Gmail și Drive din mai multe conturi Google, într-un singur loc.
Nu există server: cheile de acces Google rămân doar în memoria paginii, iar în browser se păstrează doar lista adreselor.

## Configurare

1. În Google Cloud (același proiect ca aplicația de telefon), la **Credențiale**, creează un *OAuth client ID* de tip **Web application**.
2. La *Authorized JavaScript origins* adaugă adresa paginii, de exemplu `https://socc1998.github.io`.
3. Pune Client ID-ul în `config.js`.
4. Activează GitHub Pages pentru acest depozit (Settings, Pages, ramura `main`, dosarul `/ (root)`).

Doar adresele adăugate ca „test users” în proiectul Google Cloud se pot conecta.
