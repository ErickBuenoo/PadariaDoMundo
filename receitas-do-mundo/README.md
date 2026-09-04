# 🥐 Padaria do Mundo

> Uma padaria virtual com **641 receitas tradicionais de 62 países**, com sistema de contas,
> favoritos, caderno de receitas feitas, lista de desejos e receita surpresa.

## 📁 Estrutura do projeto

```
receitas-do-mundo/
├── index.html          # Página principal
├── style.css           # Todo o estilo (padaria tradicional)
├── app.js              # Lógica do front (receitas, filtros, busca, modais)
├── auth.js             # Autenticação e ações do usuário (front)
├── data.js             # Receitas principais (106 no núcleo)
├── server.py           # Backend Flask (autenticação + API)
├── assets/             # Ícones SVG e imagens decorativas
│   ├── icons.svg       # Sprite sheet com todos os ícones vetoriais
│   ├── chef-hat.svg
│   ├── bread-icon.svg
│   ├── cupcake.svg, wheat.svg, rolling-pin.svg, spoon.svg, divider.svg
├── receitas/           # 62 arquivos JSON com receitas extras (535 total)
└── padaria.db          # Banco de dados SQLite (criado automaticamente)
```

## 🚀 Como rodar na sua máquina

### 1. Pré-requisitos
- **Python 3.8+** instalado ([baixar](https://www.python.org/downloads/))

### 2. Copie a pasta para sua máquina
Baixe todos os arquivos da pasta `receitas-do-mundo/` para uma pasta do seu computador.

### 3. Instale as dependências
Abra o terminal/console na pasta e execute:

```bash
pip install -r requirements.txt
```

Isso instala o Flask e o Waitress (servidor de produção).

### 4. Rode o servidor

```bash
python3 server.py            # Linux/Mac
python server.py             # Windows
```

Você verá algo como:

```
============================================================
🥐 Padaria do Mundo (seguro)
   Porta: 8080
   HTTPS: False
   DEV MODE: True
   DB: [...]/padaria.db
============================================================
Serving on http://0.0.0.0:8080
```

### 5. Acesse no navegador
Abra **http://localhost:8080** e pronto! 🎉

---

## ⚙️ Configurando e-mail real (SMTP)

Por padrão o site roda em **modo dev** — e-mails de verificação/recuperação de senha
aparecem numa bandeja laranja no canto inferior esquerdo (perfeito para testar).

Para enviar e-mails de verdade, configure estas variáveis de ambiente
**antes de rodar o servidor**:

```bash
# Linux / Mac
export SMTP_HOST=smtp.sendgrid.net         # ou smtp.gmail.com, smtp.mailgun.org
export SMTP_PORT=587
export SMTP_USER=apikey                    # seu usuário SMTP
export SMTP_PASS=SG.sua_chave_aqui         # sua senha/API key
export SMTP_FROM=no-reply@seusite.com
python3 server.py
```

```powershell
# Windows PowerShell
$env:SMTP_HOST = "smtp.sendgrid.net"
$env:SMTP_PORT = "587"
$env:SMTP_USER = "apikey"
$env:SMTP_PASS = "SG.sua_chave_aqui"
$env:SMTP_FROM = "no-reply@seusite.com"
python server.py
```

### Provedores recomendados (grátis ou baratos):
- **SendGrid** – 100 e-mails/dia grátis
- **Mailgun** – 5.000 e-mails grátis nos primeiros 3 meses
- **Brevo** (antes Sendinblue) – 300 e-mails/dia grátis
- **Gmail App Password** – para uso pessoal (ative senha de app na sua conta Google com 2FA)

---

## 🔒 Colocando em produção (HTTPS)

Para rodar num servidor de verdade com domínio:

```bash
export SMTP_HOST=... SMTP_PORT=... SMTP_USER=... SMTP_PASS=... SMTP_FROM=...
export PADARIA_HTTPS=1     # ativa cookies Secure e HSTS
export PORT=8080
python3 server.py
```

Na frente coloque um **Nginx** como reverse proxy com HTTPS (Let's Encrypt grátis):

```nginx
server {
    listen 443 ssl http2;
    server_name seusite.com;

    ssl_certificate /etc/letsencrypt/live/seusite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seusite.com/privkey.pem;

    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### Banco de dados
O arquivo `padaria.db` é o banco SQLite. Faça backups regulares:

```bash
cp padaria.db backups/padaria-$(date +%Y%m%d).db
```

Se um dia você crescer muito, pode migrar fácil para PostgreSQL — basta trocar a conexão no `server.py`.

---

## 🛠 Usando Docker (opcional)

Crie um `Dockerfile`:

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["python", "server.py"]
```

E rode:
```bash
docker build -t padaria-do-mundo .
docker run -p 8080:8080 -v $(pwd)/data:/app padaria-do-mundo
```

---

## 🧪 Primeiro acesso

1. Abra **http://localhost:8080**
2. Clique em **"Entrar"** no menu superior
3. Clique em **"Criar conta"**
4. Cadastre-se — o e-mail de confirmação aparece na bolinha laranja 📬 no canto inferior esquerdo (modo dev)
5. Clique no link de confirmação no e-mail
6. Explore as receitas, favorite, marque como feitas e adicione à lista de desejos!

---

## 📦 Adicionando mais receitas

Para acrescentar receitas novas de um país, basta editar o arquivo
`receitas/<slug-do-pais>.json` e adicionar objetos no array `recipes`:

```json
{
  "pais": "Brasil",
  "recipes": [
    {
      "id": "brasil-nova-receita",
      "nome": "Nome da receita",
      "pais": "Brasil",
      "flag": "🇧🇷",
      "categoria": "doces",
      "tempo": "45 min",
      "porcoes": "8 porções",
      "dificuldade": "Fácil",
      "desc": "Descrição curta.",
      "historia": "História e curiosidades...",
      "ingredientes": ["2 xícaras de...", "..."],
      "passos": ["Primeiro passo...", "Depois..."],
      "dica": "Dica do padeiro!"
    }
  ]
}
```

Categorias válidas: `paes`, `doces`, `salgados`, `massas`, `pratos`, `sopas`,
`bebidas`, `cafemanha`.

---

## 📝 Licença

Projeto pessoal. Receitas e conteúdo são livres para uso educacional e pessoal.

Bom apetite! 🍞
