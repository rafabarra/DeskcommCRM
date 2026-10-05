---
impacto: capacidade_nova
secao: adicionado
titulo: A instalação pode guardar o App ID e a URL de Cadastro Incorporado da Meta
---

Admin › API Oficial (Meta) passa a guardar o ID público do aplicativo e a URL
HTTPS de Cadastro Incorporado hospedada pela Meta. A preparação é server-side:
o valor salvo na instalação é a autoridade, e o App ID antigo do servidor segue
como reserva para instalações já configuradas.

Esta etapa não inicia login, não troca código por token e não conecta número.
App Secret continua cifrado e nunca volta à tela; Verify Token mantém a geração,
rotação e exibição única atuais.
