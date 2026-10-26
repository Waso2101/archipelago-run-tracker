Put `.apworld` files for games that are not part of Archipelago itself here
(for example Elden Ring or Lies of P), then rebuild:

    docker compose up -d --build ap-logic

Games built into Archipelago 0.6.8 (Dark Souls III, Hollow Knight, Factorio, …) need nothing here.
`.apworld` files are not committed (see .gitignore): they belong to their own authors and licenses.
