# server-project-arvrcv

Servidor base para projetos das disciplinas de **Realidade Aumentada/Virtual** e **Visão Computacional**.

## Tecnologias

| Camada     | Tecnologia |
|------------|-----------|
| Backend    | Python 3.10+, Flask, Flask-SocketIO, Eventlet |
| CV         | OpenCV (opencv-python-headless), NumPy, Pillow |
| Frontend   | HTML5, CSS3, JavaScript (ES6+) |
| 3D / AR/VR | [A-Frame 1.6](https://aframe.io/) (WebXR), [Three.js r160](https://threejs.org/) |
| IA         | [OpenAI API](https://platform.openai.com/) (gpt-4o-mini, gpt-4o, gpt-4.1-mini, gpt-4.1-nano) |
| WebSocket  | Socket.IO v4 |

## Estrutura do projeto

```
server-project-arvrcv/
├── server.py            # Servidor Flask + Socket.IO
├── requirements.txt     # Dependências Python
├── static/
│   ├── css/style.css    # Estilos globais
│   ├── js/
│   │   ├── arvr.js      # Cliente AR/VR (Socket.IO + A-Frame)
│   │   ├── cv.js        # Cliente Visão Computacional
│   │   ├── cv3d.js      # Cliente CV → 3D (Three.js)
│   │   └── worldgen.js  # Cliente AI World Generator
│   └── vendor/
│       ├── three.module.min.js  # Three.js r160 (ES Module)
│       └── OrbitControls.js     # Controles de câmera orbital
└── templates/
    ├── index.html       # Página inicial
    ├── arvr.html        # Interface AR/VR com cena 3D
    ├── cv.html          # Interface de Visão Computacional
    └── cv3d.html        # Interface CV → 3D Bridge
    └── worldgen.html    # Interface AI World Generator
```

## Instalação e execução

```bash
# 1. Crie e ative um ambiente virtual (recomendado)
python -m venv venv
source venv/bin/activate   # Linux/macOS
# venv\Scripts\activate    # Windows

# 2. Instale as dependências
pip install -r requirements.txt

# 3. Inicie o servidor
python server.py
# ou, com a chave da OpenAI para AI World Gen:
OPENAI_API_KEY="sk-..." python server.py
```

Acesse **http://localhost:5000** no navegador.

## Interfaces

### 🏠 Página Principal (`/`)
Apresentação do projeto com links para as três interfaces e resumo dos eventos WebSocket disponíveis.

### 🥽 AR/VR (`/arvr`)
Cena 3D interativa construída com A-Frame (WebXR):
- Adicione objetos (cubo, esfera, cilindro, cone, torus, dodecaedro)
- Altere a cor de cada objeto individualmente
- Altere a cor do céu com presets (dia, noite, pôr do sol, nublado)
- Ative/desative animação de rotação por objeto
- Limpe a cena completa
- Navegue com WASD + mouse; modo VR disponível em dispositivos compatíveis

### 👁️ Visão Computacional (`/cv`)
Pipelines de processamento de imagem em tempo real via OpenCV no servidor:
- Ative a webcam ou faça upload de uma imagem
- Escolha o pipeline: Bordas (Canny), Contornos, Detecção de Rostos, Segmentação por Cor, Desfoque, Limiarização
- O resultado processado é exibido ao lado da imagem original
- Detecções (contagem de contornos, rostos, pixels de cor) são listadas em tempo real

### 🔬 CV → 3D Bridge (`/cv3d`)
Ponte entre Visão Computacional e ambiente 3D via Three.js:
- Layout de 3 painéis: feed original | resultado CV | cena Three.js
- Mapeamento automático de detecções para objetos 3D:
  - **Contornos** → formas 3D extrudadas (profundidade proporcional à área)
  - **Rostos** → esferas posicionadas (tamanho baseado na face detectada)
  - **Bordas (Canny)** → nuvem de pontos / wireframe 3D
  - **Segmentação por Cor** → nuvem de pontos colorida
  - **Limiarização** → pontos binários no espaço 3D
- Navegação orbital com mouse (OrbitControls)
- Modo broadcast: transmita sua cena 3D para outros clientes conectados
- Grid e eixos configuráveis

### 🤖 AI World Gen (`/worldgen`)
Gerador de mundos 3D a partir de prompts em linguagem natural usando a API da OpenAI:
- Digite um prompt descrevendo o ambiente desejado (ex.: "floresta encantada à noite")
- A IA gera código A-Frame completo com iluminação, animações, neblina e sombras
- Pré-visualize a cena em iframe sandbox interativo
- 8 exemplos prontos de prompts para inspiração
- Escolha o modelo: gpt-4o-mini (padrão), gpt-4o, gpt-4.1-mini, gpt-4.1-nano
- Visualize e copie o código-fonte gerado
- Baixe a cena como arquivo HTML standalone
- Compartilhe com outros clientes conectados via Socket.IO
- Galeria com histórico das últimas cenas geradas

**Configuração:** defina a variável de ambiente `OPENAI_API_KEY` antes de iniciar o servidor:

```bash
export OPENAI_API_KEY="sk-..."
python server.py
```

## API WebSocket

### Sala `arvr`

| Evento (cliente → servidor) | Payload | Descrição |
|-----------------------------|---------|-----------|
| `join_arvr` | — | Entra na sala e recebe `scene_state` |
| `arvr_command` | `{command, payload}` | Executa um comando na cena |

Comandos disponíveis:

| `command`         | `payload` | Ação |
|-------------------|-----------|------|
| `add_object`      | `{type, color}` | Adiciona objeto à cena |
| `remove_object`   | `{id}` | Remove objeto |
| `change_sky`      | `{color}` | Altera cor do céu |
| `clear_scene`     | — | Limpa toda a cena |
| `move_object`     | `{id, x, y, z}` | Move objeto |
| `change_color`    | `{id, color}` | Muda cor do objeto |
| `toggle_animation`| `{id}` | Liga/desliga animação |

| Evento (servidor → cliente) | Descrição |
|-----------------------------|-----------|
| `scene_state` | Estado completo da cena |
| `object_added` | Novo objeto criado |
| `object_removed` | Objeto removido |
| `object_moved` | Objeto movido |
| `color_changed` | Cor alterada |
| `animation_toggled` | Animação ligada/desligada |
| `sky_changed` | Cor do céu alterada |
| `scene_cleared` | Cena limpa |

### Sala `cv`

| Evento (cliente → servidor) | Payload | Descrição |
|-----------------------------|---------|-----------|
| `join_cv` | — | Entra na sala CV |
| `cv_frame` | `{image: base64, pipeline: string}` | Envia frame para processamento |

| Evento (servidor → cliente) | Payload | Descrição |
|-----------------------------|---------|-----------|
| `cv_ready` | `{message}` | Servidor pronto |
| `cv_result` | `{image: base64, pipeline, detections[]}` | Resultado processado |

Pipelines disponíveis: `edges`, `contours`, `faces`, `color`, `blur`, `threshold`

### Sala `cv3d`

| Evento (cliente → servidor) | Payload | Descrição |
|-----------------------------|---------|----------|
| `join_cv3d` | — | Entra na sala CV→3D |
| `cv3d_frame` | `{image: base64, pipeline: string}` | Envia frame para processamento 3D |
| `cv3d_broadcast` | `{geometry, pipeline}` | Retransmite dados geométricos para a sala |

| Evento (servidor → cliente) | Payload | Descrição |
|-----------------------------|---------|----------|
| `cv3d_ready` | `{message}` | Servidor pronto |
| `cv3d_result` | `{image, pipeline, detections[], geometry}` | Resultado com dados geométricos 3D |
| `cv3d_scene_update` | `{geometry, pipeline}` | Cena recebida via broadcast |

O campo `geometry` contém dados específicos por pipeline:
- `contours`: `{shapes: [{x, y, w, h, area, points}]}` – contornos simplificados
- `faces`: `{faces: [{x, y, w, h}]}` – bounding boxes dos rostos
- `edges`: `{points: [[x,y]...]}` – pixels de borda amostrados
- `color`: `{points: [[x,y]...], colors: [[r,g,b]...], total_pixels}` – nuvem de pontos colorida
- `threshold`: `{points: [[x,y]...]}` – pixels acima do limiar

### Sala `worldgen`

| Evento (cliente → servidor) | Payload | Descrição |
|-----------------------------|---------|-----------|
| `join_worldgen` | — | Entra na sala World Gen |
| `worldgen_generate` | `{prompt: string, model: string}` | Solicita geração de cena 3D via OpenAI |
| `worldgen_share` | `{html: string, prompt: string}` | Compartilha cena gerada com a sala |

| Evento (servidor → cliente) | Payload | Descrição |
|-----------------------------|---------|-----------|
| `worldgen_ready` | `{message, gallery[]}` | Servidor pronto, com galeria existente |
| `worldgen_status` | `{message}` | Atualização de progresso da geração |
| `worldgen_result` | `{html, prompt, model, tokens, error?}` | Resultado da geração |
| `worldgen_new_scene` | `{prompt, model}` | Notifica outros clientes sobre nova cena |
| `worldgen_shared_scene` | `{html, prompt}` | Cena compartilhada por outro cliente |

Modelos permitidos: `gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`, `gpt-4.1-nano`

## Expandindo o projeto

- **Novo pipeline CV**: adicione um `elif pipeline == "meu_pipeline":` em `_apply_pipeline()` em `server.py`
- **Novo objeto 3D**: adicione a tag A-Frame em `SHAPE_MAP` em `static/js/arvr.js`
- **Novo comando AR/VR**: trate o evento `arvr_command` em `server.py` e chame `sendCommand()` no cliente
- **Integração com ML**: substitua o classificador Haar por um modelo YOLO/MediaPipe no pipeline `faces`
- **Novo mapeamento 3D**: adicione um método `mapX()` em `static/js/cv3d.js` e trate no `mapGeometry()`
- **Pipeline CV→3D customizado**: adicione processamento em `_apply_pipeline_3d()` em `server.py` retornando dados geométricos específicos
