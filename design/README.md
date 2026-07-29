# Fontes de design

Arquivos-fonte dos artefatos visuais que vão para os apps. Ficam versionados
porque o que está em `public/` é **derivado**: sem a fonte, um recorte novo
(outro enquadramento, outra resolução) teria que ser refeito do zero.

## `logo-original.png`

Monograma AM do Grupo Alcina Maria, 1024×1024, fundo branco opaco.

Dele sai o `logo.png` de `apps/web-admin/public/` e `apps/web-motorista/public/`
(idênticos entre si): fundo removido para transparente e recorte fechado no
monograma, 768×768. Nos apps ele aparece dentro de um medalhão redondo — fundo
escuro com anel dourado — no cabeçalho e nas telas de login, e é por isso que a
transparência importa: com o fundo branco original, o medalhão viraria um
quadrado branco.
