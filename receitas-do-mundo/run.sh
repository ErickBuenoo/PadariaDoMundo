#!/bin/bash
# Script rápido para rodar no Linux/Mac
set -e
cd "$(dirname "$0")"

# Cria venv se não existir
if [ ! -d "venv" ]; then
  echo "📦 Criando ambiente virtual..."
  python3 -m venv venv
  source venv/bin/activate
  echo "📥 Instalando dependências..."
  pip install -q -r requirements.txt
else
  source venv/bin/activate
fi

echo "🥐 Iniciando Padaria do Mundo em http://localhost:8080 ..."
python3 server.py
