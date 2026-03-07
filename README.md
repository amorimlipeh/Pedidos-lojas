
# Pedidos Lojas - Projeto Final Unificado

Login inicial:
- usuário: `admin`
- senha: `admin123`

## O que já está junto neste projeto
- login com `/api/auth/login`
- busca de estoque em abas
- pedido de loja usando produtos do estoque importado
- ordem de pedidos feita editável
- faltas de separação com baixa de estoque
- importação de PDF original e simplificado, Excel, Word `.docx`, CSV e TXT
- edição de produto, quantidade, material e fator
- geração de PDF do pedido
- PWA simples

## Estrutura
- `server.js`
- `index.html`
- `manifest.json`
- `sw.js`
- `package.json`
- `Dockerfile`

## Deploy no Railway
1. Suba os arquivos para o GitHub.
2. Conecte o repositório no Railway.
3. O comando de start já está em `package.json`.

## Observações
- `.doc` antigo não é suportado diretamente; salve como `.docx`.
- PDFs somente imagem podem precisar de OCR.


Correção aplicada:
- parser do Excel agora lê a coluna certa de estoque atual
- parser do PDF simplificado agora lê formato em 3 linhas (código, produto, quantidade)
- parser do PDF original agora reconhece linhas com UNCODIGO - PRODUTO
- importação múltipla por vários arquivos ao mesmo tempo


Atualizações aplicadas nesta versão:
- edição de produto direto na aba Buscar estoque
- alteração de nome, material, quantidade em estoque e fator de conversão
- pedido com caixas ou unidades
- fator automático ao selecionar produto
- paginação com 10, 20, 50 e 100 produtos
- botões << < > >> para navegar páginas
