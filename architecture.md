Het doel van deze repo is om een Harness te maken die te gebruiken is met openweight modellen

Wat zijn de systeem vereisten voor de tool die ik voor ogen heb?:
 - Een harness heeft Tool calling nodig, dus een toolregister zou top zijn
    - Deze moet tevens uitbreidbaar zijn
    - Het concept skills zou ook fijn zijn binnen het harness
 - Er moet een extern memory systeem zijn (Postgres?)
 - Er moet een context compaction algoritme zijn
 - Er moet een loop en een router zijn
 - Er moet een verduidelijkingsmechanisme bestaan
Welke tech stack hiervoor gebruikt gaat worden:
 - Typescript
 - Ollama?
 - VLLM
 - Postgres
 - Redis?

 Wat zijn de componenten die ik nodig acht voor een coding agent?
 - UI (coding CLI)
 - Ik wil dat de agent zelfstandig keuzes kan maken
 - Ik wil dat de coding agent zo compact mogelijk antwoord geeft en zo weinig mogelijk tokens verbruikt
 - System prompt
 - Ik wil dat de coding agent subagents kan aanmaken en aanspreken
 - Ik wil dat de coding agent de belangrijke dingen compacteert en wegschrijft naar een dedicated plaats op een logische manier
 - 

