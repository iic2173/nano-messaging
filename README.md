# nano-messaging

Nano messaging es una PoC para un sistema de mensajería basado en pubsub para una pequeña startup.
Funciona mediante websockets y una instancia de redis para coordinar los mensajes

Dado que es una prueba de concepto, el código está desordenado y no es tan descriptivo, ademas de no ser 100% infalible. Parte del desafío para usar este código bien es entender la arquitectura y las implicancias de las decisiones que se hicieron en esta PoC, y mejorarlo/completarlo.

Si lo desean, pueden hacer un PR a la rama dev de este chat, y proponer alguna mejora o funcionalidad para futuras instancias del ramo.

El diagrama se puede encontrar en /docs/nano-messaging-components

## Features

* Sistema de mensajes escalable en base a pubsub
* Historial de mensajes
* Manejo de chats en base a rooms
* Manejo de usuarios en base a UUID
* Solamente requiere un JWT firmado para funcionar

## Stack

* Webserver: Koa
* Broker: Redis
* Base de datos de chats/rooms: Postgres
* Containers: Docker

## Overview

Este sistema ofrece rooms para que diversos usuarios conversen en un chat.
Cada room puede ser accedido por usuarios y entidades, las cuales representan grupos.

Existe una tabla de permisos para cada room, especificando que cosas pueden hacer los usuarios y entidades en cada room, si están aceptados y que nivel tienen en el room. Estos rooms tienen dos propietarios: un usuario específico y una entidad a la que este pertenece. 

Así entonces, un usuario puede entrar por su propio mérito, o a causa de algún grupo que lo autorizó.

## Setup

Debe levantar la app con docker-compose

```
docker-compose up -d
```

Posteriormente, ejecute las migraciones necesarias

```
docker-compose exec api npx sequelize db:migrate
```

Su app está lista para funcionar

## Modo de uso 

### Token

Para empezar a usar el sistema, debe ensamblar un token con la siguiente composición

Este token tiene la siguiente composición

```json=
{
    "aud":"chat.nano-messaging.net",
    "iss":"api.nano-messaging.net",
    "exp":999999999999,
    "sub":"xxxxxx-xxxxx...."
    "entityUUID":"xxxxxx-xxxxx....",
    "userUUID":"xxxxxx-xxxxx....",
    "levelOnEntity":"100"
}
```

* `userUUID` se refiere a un usuario con capacidades de uso del chat, y se usará su UUID para inscribirlo en los rooms asi como para manejar los permisos.
* `entityUUID` se refiere a la entidad padre del usuario (tal como si el usuario perteneciera a una organización). Esto es para poder entrar a rooms que autorizan en base a una entidad padre común para ciertos usuarios
* `levelOnEntity` se refiere al nivel de autorizacion asignado por el sistema de usuarios principal. Un nivel de 100 permite crear rooms, aunque se sugiere que esto sea cambiado a alguna autorización para crear rooms en especifico
* `aud`, `iss` y `exp` tienen los significados originales en la especificación JWT (RFC-7519). `sub` podría sustituir a `userUUID` pero no se usa.

Este token debe estar firmado con un secreto conjunto con el servicio original que provee los usuarios de este chat. El servicio de chat asumirá que la información contenida en el token es veraz. Adicionalmente, el servicio de chat no requiere interactuar con el servicio original, solo la info contenida en el token

### Rooms

Debe crearse un room para que los usuarios puedan hablar. Esto se hace con un POST

`POST /rooms`

```json=
{
    "name":"xxxxxxxxxxxx",
    "level_admin":"9999",
    "type":"group"
}
```

`name` define el nombre del room, `level_admin` el nivel necesario para modificar el room y sus permisos y `type` el tipo de room (no implementado, pero puede ser `group` para rooms multiusuario, y `user2user` para rooms de máximo dos personas)

Posteriormente puede invitar mas miembros añadiendolos mediante una regla en la tabla de permisos. Use un `PUT` para añadir esta regla, o modificar reglas anteriores

`PUT /rooms/:id/members`

```json=
{
    "entity_UUID":"",
    "permissions":false,
    "level":999999
}
```

`entity_UUID` se refiere al UUID del usuario al que se quiere autorizar. `permissions` es un string definiendo permisos (use `rw`)

```
 * r = read
 * w = write
 * b = banned
 * a = admin
```

Y `level` da el nivel de acceso para esa entidad. Nótese que cada entidad puede representar un usuario o una entidad arbitraria.
Más de 10 reglas genera un error, aunque este es un límite arbitrario.

### Chatear

Para usar el chat, un usuario debe abrir un websocket en la ruta `/chat`. Este websocket funciona en base a un sistema de órdenes (tipo ordenes AT) pero usando una estructura JSON. El sistema responderá `START?` al comenzar

Para comenzar, debe enviar un mensaje con el token especificado anteriormente

```json=
{
    "type":"token",
    "content":"token.jwt.secreto"
}
```

Un token firmado correctamente responderá `READY` (dentro de un JSON) y uno incorrecto `TOKEN?`. Muchos intentos incorrectos originan un error `BADAUTH`

Posteriormente, debe seleccionar un room activo

```json=
{
    "type":"select_room",
    "room_id":99999
}
```

Al seleccionar un room correcto, recibirá todos los mensajes dirigidos a ese room, así como enviar mensajes. Para enviar un mensaje, debe enviar este formato

```json=
{
    "type":"message",
    "content":"Fueled up and ready to go"
}
```

Recibirá el echo de sus propios mensajes.
Cada mensaje llegará

### Estructura

```
├── README.md - Este archivo
├── api
│   ├── Dockerfile - Dockerfile para staging
│   ├── Dockerfile.dev - Dockerfile para desarrollo
│   ├── index.js - Script de inicializacion
│   ├── nodemon.json - Configuracion para el modo de desarrollo
│   ├── package-lock.json - Archivo lock para consistencia de paquetes
│   ├── package.json - Descriptor de paquetes
│   ├── sonar-project.properties - Archivo para análisis Sonarqube (no usado)
│   └── src
│       ├── app.js - Código principal de la aplicación
│       ├── config - Configuraciones de la base de datos
│       │   └── database.js
│       ├── migrations
│       ├── models
│       │   ├── index.js
│       │   ├── message.js
│       │   ├── room.js
│       │   └── room_permission.js
│       ├── routes
│       │   ├── chat.js
│       │   ├── index.js
│       │   ├── messages.js
│       │   └── rooms.js
│       └── routes.js
└── docker-compose.yml - Compose para desarrollo

```

### By
Dynaptics