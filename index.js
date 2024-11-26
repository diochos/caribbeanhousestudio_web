const express = require('express');
const app = express();
const mysql = require('mysql2');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const { PORT, DB_HOST, DB_NAME, DB_PASSWORD, DB_USER, DB_PORT } = require('./config');
const multer = require('multer'); // Asegúrate de tener esto aquí
const bcrypt = require('bcrypt'); // Asegúrate de tener esta línea
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const fetch = require('node-fetch'); 

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Configuración del cliente S3 con las nuevas credenciales
const s3 = new S3Client({
  region: 'auto', // Cloudflare R2 no requiere región específica
  endpoint: 'https://9da33335d2c28a44cc8e07d04747ed4c.r2.cloudflarestorage.com', // Endpoint de tu bucket
  credentials: {
    accessKeyId: 'a8a5ce4145688c3d1ed0212da9e362d1', // Access Key ID actualizado
    secretAccessKey: '2cd1ebbf7b8812d92f85904620328dcb474ea864f14c294ec88a9952faa663a0', // Secret Access Key actualizado
  },
});

// Configuración de multer para manejar archivos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Archivo: index.js (o tu archivo principal del servidor)

// Cargar variables de entorno
require('dotenv').config(); // Si usas un archivo .env

// Constante para el bucket de imágenes de Cloudflare
const CFI = process.env.CFI || "https://pub-9eb3385798dc4bcba46fb69f616dc1a0.r2.dev";

// Hacer que la constante esté disponible para todas las vistas
app.use((req, res, next) => {
  res.locals.CFI = CFI; // Esto hace que `CFI` esté disponible en EJS
  next();
});




const db = mysql.createConnection({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  port: DB_PORT,
  database: DB_NAME
});


// Configuración de la sesión
const sessionStore = new MySQLStore({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT
});

app.use(session({
  key: 'caribbeanhouse_session', // Cambia el nombre de la cookie si lo deseas
  secret: 'tusuperclaveultrasecreta12345', // Cambia esta clave secreta por algo más seguro
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
      maxAge: 1000 * 60 * 60 * 24 // 1 día de duración de la sesión
  }
}));

db.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL');
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(express.static(path.join(__dirname, 'src')));
app.use(bodyParser.json());

app.get("/", (req, res) => {
  console.log("Request received for /");
  db.query('SELECT nombre FROM Usuarios', (err, results) => {
    if (err) {
      console.error('Error fetching client names:', err);
      res.status(500).send('Error fetching client names');
      return;
    }

    const clientes = results.map(row => row.nombre);
    res.render('dashboard', { clientes });
  });
});


// ########################################## AUTENTICACIÓN SIMPLE
// Middleware de autenticación simple para las rutas del colaborador
const authMiddleware = (req, res, next) => {
  const auth = { login: 'admin', password: 'caribean2024' }; // Usuario y contraseña

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && login === auth.login && password === auth.password) {
    return next();
  }

  // Si la autenticación falla
  res.set('WWW-Authenticate', 'Basic realm="Colaborador"');
  res.status(401).send('Autenticación requerida.');
};

// ########################################## MENÚ DE COLABORADOR
// Rutas protegidas por la autenticación para el colaborador
app.get('/colaborador/menu', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/menu.html'));
});

app.get('/colaborador/productos/crear', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/productos/crear_producto.html'));
});



//########################################################### STOCK  ##################################################

app.get('/colaborador/productos/stock', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/productos/stock.html'));
});

// Ruta para obtener los productos y enviar los datos al frontend
app.get('/colaborador/productos/data', authMiddleware, (req, res) => {
  const query = 'SELECT * FROM Productos'; // Consulta a la base de datos para obtener todos los productos

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching products:', err);
      return res.status(500).json({ error: 'Error fetching products' });
    }

    res.json({ productos: results }); // Enviar los productos como respuesta JSON
  });
});

//########################################################### eliminar productos  ##################################################

const { DeleteObjectCommand, ListObjectsCommand } = require('@aws-sdk/client-s3');

app.delete('/colaborador/productos/eliminar/:codigo', authMiddleware, async (req, res) => {
  const productoCodigo = req.params.codigo;

  try {
    // Buscar el producto por código para obtener su ID
    const [result] = await db.promise().query('SELECT producto_id FROM Productos WHERE codigo = ?', [productoCodigo]);
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado' });
    }

    const productId = result[0].producto_id;

    // Eliminar el producto de la base de datos
    await db.promise().query('DELETE FROM Productos WHERE codigo = ?', [productoCodigo]);

    // Eliminar los archivos relacionados del bucket en R2
    const folderPath = `Products/${productId}/`;

    // Listar todos los objetos dentro de la carpeta del producto
    const listParams = {
      Bucket: 'products',
      Prefix: folderPath,
    };

    const listedObjects = await s3.send(new ListObjectsCommand(listParams));

    if (listedObjects.Contents && listedObjects.Contents.length > 0) {
      for (const object of listedObjects.Contents) {
        const deleteParams = {
          Bucket: 'products',
          Key: object.Key,
        };
        await s3.send(new DeleteObjectCommand(deleteParams));
        console.log(`Eliminado del bucket: ${object.Key}`);
      }
    }

    res.json({ success: true, message: 'Producto eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar el producto:', error.message);
    res.status(500).json({ success: false, error: 'Error interno al eliminar el producto' });
  }
});


// Ruta para actualizar el stock de los productos
app.post('/colaborador/productos/actualizar-stock', authMiddleware, (req, res) => {
  const productos = req.body.productos;

  // Validar que haya productos
  if (!productos || productos.length === 0) {
    return res.status(400).json({ success: false, error: 'No se enviaron productos para actualizar' });
  }

  // Actualizar el stock de cada producto en la base de datos
  let query = 'UPDATE Productos SET stock = ? WHERE codigo = ?';
  productos.forEach(producto => {
    const { codigo, stock } = producto;
    db.query(query, [stock, codigo], (err, result) => {
      if (err) {
        console.error('Error al actualizar el stock:', err);
        return res.status(500).json({ success: false, error: 'Error al actualizar el stock' });
      }
    });
  });

  res.json({ success: true });
});





//################################# CREAR PRODUCTOS ##################################################



// Ruta para crear productos y subir imágenes
app.post('/colaborador/productos/crear', upload.array('imagenes', 4), async (req, res) => {
  const { nombre, precio, categoria, codigo, stock, material, dimensiones, acabado, color, descripcion1, descripcion2 } = req.body;

  if (!nombre || !precio || !categoria || !codigo || !stock || !material || !dimensiones || !acabado || !color || !descripcion1 || !descripcion2) {
    return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
  }

  try {
    const query = 'INSERT INTO Productos (nombre, precio, categoria, codigo, stock) VALUES (?, ?, ?, ?, ?)';
    const values = [nombre, precio, categoria, codigo, stock];

    db.query(query, values, async (err, results) => {
      if (err) {
        console.error('Error al crear producto:', err.message);
        return res.status(500).json({ success: false, error: 'Error al crear producto' });
      }

      const productId = results.insertId;
      const productPath = `Products/${productId}/`;

      // Subir imágenes al bucket
      const imageFiles = req.files || [];
      if (imageFiles.length === 0) {
        return res.status(400).json({ success: false, error: 'Debes subir al menos una imagen.' });
      }

      const imageNames = ['a.webp', 'b.webp', 'c.webp', 'd.webp'];
      const placeholderPath = path.join(__dirname, 'src', 'Templates', 'placeholder.webp');

      for (let i = 0; i < 4; i++) {
        const file = imageFiles[i];
        const imagePath = `${productPath}${imageNames[i]}`;

        let params;
        if (file) {
          // Usar la imagen subida por el usuario
          params = {
            Bucket: 'products',
            Key: imagePath,
            Body: file.buffer,
            ContentType: file.mimetype,
          };
        } else {
          // Usar el placeholder si no se subió una imagen
          const placeholderBuffer = fs.readFileSync(placeholderPath);
          params = {
            Bucket: 'products',
            Key: imagePath,
            Body: placeholderBuffer,
            ContentType: 'image/webp',
          };
        }

        try {
          await s3.send(new PutObjectCommand(params));
          console.log(`Imagen subida correctamente: ${imagePath}`);
        } catch (uploadError) {
          console.error(`Error subiendo imagen ${imageNames[i]}:`, uploadError.message);
          return res.status(500).json({ success: false, error: `Error subiendo imagen ${imageNames[i]}` });
        }
      }

      // Crear y subir el archivo info.txt
      const infoContent = `Información Básica\nNombre: ${nombre}\nMaterial: ${material}\nDimensiones: ${dimensiones}\nAcabado: ${acabado}\nColor: ${color}\n\n` +
                          `Información de Catálogo\nPrecio: ${precio}\nCategoría: ${categoria}\nDescripción 1: ${descripcion1}\nDescripción 2: ${descripcion2}`;

      const infoParams = {
        Bucket: 'products',
        Key: `${productPath}info.txt`,
        Body: infoContent,
        ContentType: 'text/plain',
      };

      try {
        await s3.send(new PutObjectCommand(infoParams));
        console.log('Archivo info.txt subido correctamente.');
      } catch (infoError) {
        console.error('Error subiendo info.txt:', infoError.message);
        return res.status(500).json({ success: false, error: 'Error subiendo info.txt' });
      }

      res.json({ success: true, redirectUrl: '/colaborador/productos/stock' });
    });
  } catch (err) {
    console.error('Error general al procesar el producto:', err.message);
    res.status(500).json({ success: false, error: 'Error general al procesar el producto' });
  }
});

//################################# crear codigS ##################################################

app.get('/colaborador/productos/generar-codigo', (req, res) => {
  const categoria = req.query.categoria;

  // Prefijos para las categorías
  const prefixMapping = {
    'Decoración': 'DEC',
    'Salas': 'SAL',
    'Mesas': 'MES',
    'Sillas y bancos': 'SYB',
    'Recámara': 'REC',
    'Exterior': 'EXT',
    'Almacenaje': 'ALM',
    'Varios': 'VAR'
  };

  const prefix = prefixMapping[categoria];

  if (!prefix) {
    return res.status(400).json({ success: false, error: 'Categoría no válida' });
  }

  const query = 'SELECT COUNT(*) AS total FROM Productos WHERE codigo LIKE ?';
  const likePrefix = `${prefix}%`;

  db.query(query, [likePrefix], (err, results) => {
    if (err) {
      console.error('Error al generar el código:', err);
      return res.status(500).json({ success: false, error: 'Error al generar el código' });
    }

    const totalProductos = results[0].total + 1;
    const codigo = `${prefix}${String(totalProductos).padStart(5, '0')}`;

    res.json({ codigo });
  });
});


//################################# MODIFICAR PRODUCTOS ##################################################
// Ruta para modificar un producto
app.post('/colaborador/productos/modificar/:codigo', upload.array('imagenes', 4), async (req, res) => {
  const { nombre, precio, categoria, stock, material, dimensiones, acabado, color, descripcion1, descripcion2 } = req.body;
  const codigoProducto = req.params.codigo;

  if (!nombre || !precio || !categoria || !stock) {
    return res.status(400).json({ success: false, error: 'Los campos nombre, precio, categoría y stock son obligatorios' });
  }

  try {
    // Obtener el producto_id basado en el código del producto
    db.query('SELECT producto_id FROM Productos WHERE codigo = ?', [codigoProducto], async (err, result) => {
      if (err) {
        console.error('Error al obtener el producto_id:', err);
        return res.status(500).json({ success: false, error: 'Error al obtener el producto' });
      }

      if (result.length === 0) {
        return res.status(404).json({ success: false, error: 'Producto no encontrado' });
      }

      const productoId = result[0].producto_id;
      const productPath = `Products/${productoId}/`;

      // Actualizar los datos básicos del producto en la base de datos
      const updateQuery = 'UPDATE Productos SET nombre = ?, precio = ?, categoria = ?, stock = ? WHERE codigo = ?';
      const values = [nombre, precio, categoria, stock, codigoProducto];

      db.query(updateQuery, values, async (err) => {
        if (err) {
          console.error('Error al actualizar el producto:', err);
          return res.status(500).json({ success: false, error: 'Error al actualizar el producto' });
        }

        // Manejo de imágenes subidas
        const imageFiles = req.files || [];
        const imageNames = ['a.webp', 'b.webp', 'c.webp', 'd.webp'];
        const placeholderPath = path.join(__dirname, 'src', 'Templates', 'placeholder.webp');

        for (let i = 0; i < 4; i++) {
          const imagePath = `${productPath}${imageNames[i]}`;

          if (imageFiles[i]) {
            // Subir las nuevas imágenes proporcionadas
            const file = imageFiles[i];
            const params = {
              Bucket: 'products',
              Key: imagePath,
              Body: file.buffer,
              ContentType: file.mimetype,
            };

            try {
              await s3.send(new PutObjectCommand(params));
              console.log(`Imagen subida correctamente: ${imagePath}`);
            } catch (uploadError) {
              console.error(`Error subiendo la imagen ${imageNames[i]}:`, uploadError.message);
              return res.status(500).json({ success: false, error: `Error subiendo la imagen ${imageNames[i]}` });
            }
          } else {
            // Completar las imágenes faltantes con el placeholder
            const placeholderBuffer = fs.readFileSync(placeholderPath);
            const params = {
              Bucket: 'products',
              Key: imagePath,
              Body: placeholderBuffer,
              ContentType: 'image/webp',
            };

            try {
              await s3.send(new PutObjectCommand(params));
              console.log(`Placeholder subido correctamente para: ${imagePath}`);
            } catch (placeholderError) {
              console.error(`Error subiendo placeholder para ${imageNames[i]}:`, placeholderError.message);
              return res.status(500).json({ success: false, error: `Error subiendo placeholder para ${imageNames[i]}` });
            }
          }
        }

        // Actualizar el archivo info.txt en Cloudflare R2
        const infoContent = `Información Básica\nNombre: ${nombre}\nMaterial: ${material}\nDimensiones: ${dimensiones}\nAcabado: ${acabado}\nColor: ${color}\n\n` +
                            `Información de Catálogo\nPrecio: ${precio}\nCategoría: ${categoria}\nDescripción 1: ${descripcion1}\nDescripción 2: ${descripcion2}`;

        const infoParams = {
          Bucket: 'products',
          Key: `${productPath}info.txt`,
          Body: infoContent,
          ContentType: 'text/plain',
        };

        try {
          await s3.send(new PutObjectCommand(infoParams));
          console.log('Archivo info.txt actualizado correctamente.');
        } catch (infoError) {
          console.error('Error actualizando el archivo info.txt:', infoError.message);
          return res.status(500).json({ success: false, error: 'Error actualizando el archivo info.txt' });
        }

        res.json({ success: true, message: 'Producto actualizado correctamente.' });
      });
    });
  } catch (err) {
    console.error('Error general al procesar la solicitud:', err.message);
    res.status(500).json({ success: false, error: 'Error general al procesar la solicitud.' });
  }
});

app.get('/colaborador/productos/data/:codigo', (req, res) => {
  const codigoProducto = req.params.codigo;

  db.query('SELECT * FROM Productos WHERE codigo = ?', [codigoProducto], (err, result) => {
    if (err) {
      console.error('Error al obtener los datos del producto:', err);
      return res.status(500).json({ success: false, error: 'Error al obtener los datos del producto' });
    }

    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado' });
    }

    res.json({ success: true, producto: result[0] });
  });
});

app.get('/colaborador/productos/modificar', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/productos/modificar_producto.html'));
});



//####################################### COMPRAS MONITOREO Y MODIFICACION DESDE COLABORADOT #####################################

app.get('/colaborador/ordenes', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/compras/ordenes.html'));
});

app.get('/colaborador/ordenes/data', authMiddleware, (req, res) => {
  const query = `
    SELECT 
      ordenes.orden_id,  -- Asegúrate de incluir este campo
      ordenes.numero_orden, 
      Usuarios.nombre AS cliente_nombre, 
      ordenes.referencia, 
      ordenes.fecha_orden 
    FROM ordenes
    INNER JOIN Usuarios ON ordenes.usuario_id = Usuarios.usuario_id
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching orders:', err);
      return res.status(500).json({ error: 'Error fetching orders' });
    }

    res.json({ ordenes: results });
  });
});


app.get('/colaborador/ordenes/compras/:orden_id', authMiddleware, (req, res) => {
  const ordenId = req.params.orden_id;

  const query = `
    SELECT c.compra_id, p.nombre AS producto_nombre, c.cantidad, c.fecha_compra, c.direccion_envio, c.estado
    FROM Compras c
    JOIN Productos p ON c.producto_id = p.producto_id
    WHERE c.orden_id = ?
  `;

  db.query(query, [ordenId], (err, results) => {
    if (err) {
      console.error('Error fetching purchases:', err);
      return res.status(500).json({ error: 'Error fetching purchases' });
    }

    res.json({ compras: results });
  });
});


app.get('/colaborador/compras/:ordenId', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/compras/compras.html'));
});

//####################################### crear compra #####################################

// Endpoint para renderizar la página de crear orden
app.get('/colaborador/ordenes/crear', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/compras/crear_orden.html'));
});



app.post('/colaborador/ordenes/crear', authMiddleware, (req, res) => {
  const { correo, referencia, productos, direccion } = req.body;

  // Validación del correo
  if (!correo || !direccion || productos.length === 0) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios.' });
  }

  // Verificar si el cliente ya está en el sistema
  const verificarCliente = `
      SELECT usuario_id, prerregistro FROM Usuarios WHERE correo = ?;
  `;
  db.query(verificarCliente, [correo], (err, usuarios) => {
      if (err) {
          console.error('Error al verificar cliente:', err);
          return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
      }

      let usuarioId = null;

      // Si el usuario no existe, lo registramos
      if (usuarios.length === 0) {
          const registrarUsuario = `
              INSERT INTO Usuarios (correo, nombre, telefono, prerregistro, password)
              VALUES (?, ?, ?, 1, '');
          `;
          db.query(registrarUsuario, [correo, 'Cliente', '', 1], (err, result) => {
              if (err) {
                  console.error('Error al registrar usuario:', err);
                  return res.status(500).json({ success: false, error: 'Error al registrar cliente.' });
              }

              usuarioId = result.insertId; // Nuevo ID del usuario
              crearOrden(usuarioId);
          });
      } else {
          // Usuario ya existe
          usuarioId = usuarios[0].usuario_id;
          crearOrden(usuarioId);
      }

      // Crear la orden
      function crearOrden(usuarioId) {
          const obtenerUltimoNumero = `
              SELECT numero_orden FROM ordenes ORDER BY orden_id DESC LIMIT 1;
          `;
          db.query(obtenerUltimoNumero, (err, resultados) => {
              if (err) {
                  console.error('Error al obtener último número de orden:', err);
                  return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
              }

              const ultimoNumero = resultados.length > 0 ? resultados[0].numero_orden : 'ORD-0000';
              const nuevoNumero = generarNumeroOrden(ultimoNumero);

              const insertarOrden = `
                  INSERT INTO ordenes (numero_orden, usuario_id, referencia, fecha_orden)
                  VALUES (?, ?, ?, NOW());
              `;
              db.query(insertarOrden, [nuevoNumero, usuarioId, referencia], (err, result) => {
                  if (err) {
                      console.error('Error al crear orden:', err);
                      return res.status(500).json({ success: false, error: 'Error al crear la orden.' });
                  }

                  const ordenId = result.insertId;

                  // Insertar productos en la tabla Compras
                  const insertarCompras = `
                      INSERT INTO Compras (producto_id, usuario_id, fecha_compra, estado, direccion_envio, cantidad, orden_id)
                      VALUES ?
                  `;
                  const valoresCompras = productos.map(producto => [
                      producto.producto_id,
                      usuarioId,
                      new Date(),
                      1,
                      direccion,
                      producto.cantidad,
                      ordenId,
                  ]);

                  db.query(insertarCompras, [valoresCompras], (err) => {
                      if (err) {
                          console.error('Error al insertar productos:', err);
                          return res.status(500).json({ success: false, error: 'Error al agregar productos.' });
                      }

                      res.json({ success: true, message: 'Orden creada correctamente.', ordenId });
                  });
              });
          });
      }
  });
});



//####################################### Modificar estado #####################################

// Endpoint para obtener los datos de una compra específica
app.get('/colaborador/compras/data/:compra_id', authMiddleware, (req, res) => {
  const compraId = req.params.compra_id;

  const query = `
    SELECT Compras.compra_id, Productos.nombre AS producto_nombre, Compras.estado
    FROM Compras
    JOIN Productos ON Compras.producto_id = Productos.producto_id
    WHERE Compras.compra_id = ?
  `;

  db.query(query, [compraId], (err, results) => {
    if (err) {
      console.error('Error al obtener compra:', err);
      return res.status(500).json({ success: false, error: 'Error al obtener la compra' });
    }

    if (results.length === 0) {
      return res.status(404).json({ success: false, error: 'Compra no encontrada' });
    }

    res.json({ success: true, compra: results[0] });
  });
});


app.get('/colaborador/compras/modificar-estado/:compra_id', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'src/colaborador/compras/modificar_estado.html'));
});


// Endpoint para modificar el estado de la compra
app.post('/colaborador/compras/modificar-estado/:compra_id', authMiddleware, (req, res) => {
  const compraId = req.params.compra_id;
  const { estado } = req.body;

  if (!estado) {
    return res.status(400).json({ success: false, error: 'El estado es obligatorio.' });
  }

  const query = 'UPDATE Compras SET estado = ? WHERE compra_id = ?';

  db.query(query, [estado, compraId], (err, results) => {
    if (err) {
      console.error('Error al actualizar estado:', err);
      return res.status(500).json({ success: false, error: 'Error al actualizar el estado' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Compra no encontrada.' });
    }

    res.json({ success: true, message: 'Estado actualizado correctamente.' });
  });
});





















//########################################## SEGUIMIENTO ##################################################


app.get('/seguimiento', async (req, res) => { // Declarar la función como async
  const idCompra = req.query.id;

  try {
    // Obtener la compra
    const [compraResults] = await db.promise().query('SELECT * FROM Compras WHERE compra_id = ?', [idCompra]);
    if (compraResults.length === 0) {
      return res.send('Compra no encontrada');
    }

    const compra = compraResults[0];

    // Obtener el producto
    const [productoResults] = await db.promise().query('SELECT * FROM Productos WHERE producto_id = ?', [compra.producto_id]);
    if (productoResults.length === 0) {
      return res.send('Producto no encontrado');
    }

    const producto = productoResults[0];

    // Leer el archivo info.txt desde Cloudflare R2
    const productInfoPath = `${CFI}/Products/${compra.producto_id}/info.txt`;
    let info = {};

    try {
      const response = await fetch(productInfoPath); // Ahora está dentro de una función async
      if (!response.ok) {
        throw new Error(`Error al obtener el archivo info.txt: ${response.statusText}`);
      }
      const data = await response.text();

      // Procesar el contenido del archivo info.txt
      const infoLines = data.split('\n');
      let currentSection = null;

      infoLines.forEach(line => {
        if (line.trim() === "Información Básica") {
          currentSection = "basic";
          info[currentSection] = {};
        } else if (line.trim() === "Información de Catálogo") {
          currentSection = "catalog";
          info[currentSection] = {};
        } else if (line.trim() !== "") {
          const [key, value] = line.split(': ');
          if (currentSection && key && value) {
            info[currentSection][key.trim()] = value.trim();
          }
        }
      });
    } catch (error) {
      console.error(`Error al leer el archivo info.txt: ${error.message}`);
      info = { basic: {}, catalog: {} }; // Devolver valores vacíos si ocurre un error
    }

    // Dividir la dirección de envío
    const direccionParts = compra.direccion_envio.split(', ');

    // Renderizar la página
    res.render('seguimiento', {
      idCompra,
      estado: compra.estado,
      producto: {
        ...producto,
        path_imagen: `${CFI}/Products/${compra.producto_id}/a.webp`
      },
      info: info.basic,
      direccion: {
        calle: direccionParts[0],
        ciudad: direccionParts[1],
        estado: direccionParts[2],
        codigoPostal: direccionParts[3]
      }
    });
  } catch (error) {
    console.error(`Error en la ruta /seguimiento: ${error.message}`);
    res.status(500).send('Error interno del servidor');
  }
});



//########################################## COMPRAS 987 ##################################################
// Ruta `/compras`
app.get('/compras', (req, res) => {
  const userId = req.session.userId;

  // Verificar que el usuario esté autenticado
  if (!userId) {
    return res.redirect('/login');
  }

  // Paso 1: Consultar las órdenes del usuario
  db.query('SELECT * FROM ordenes WHERE usuario_id = ?', [userId], (error, ordenes) => {
    if (error) {
      console.error('Error al consultar órdenes:', error);
      return res.status(500).send('Error interno del servidor');
    }

    if (ordenes.length === 0) {
      return res.render('compras', {
        ordenes: [],
        compras: [],
        mensaje: 'No se encontraron órdenes para este usuario.',
        searchQuery: '' // Asegurar `searchQuery` para evitar errores en el EJS
      });
    }

    // Paso 2: Obtener las compras relacionadas con las órdenes
    const ordenIds = ordenes.map(orden => orden.orden_id);

    const query = `
      SELECT 
        Compras.*, 
        Productos.nombre AS producto_nombre, 
        Productos.precio AS producto_precio, 
        Productos.categoria AS producto_categoria, 
        Productos.codigo AS producto_codigo,
        Productos.producto_id AS producto_id 
      FROM 
        Compras 
      LEFT JOIN 
        Productos 
      ON 
        Compras.producto_id = Productos.producto_id 
      WHERE 
        Compras.orden_id IN (?);
    `;

    db.query(query, [ordenIds], (error, compras) => {
      if (error) {
        console.error('Error al consultar compras:', error);
        return res.status(500).send('Error interno del servidor');
      }

      if (compras.length === 0) {
        return res.render('compras', {
          ordenes,
          compras: [],
          mensaje: 'No se encontraron compras asociadas a las órdenes.',
          searchQuery: ''
        });
      }

      // Paso 3: Leer `info.txt` para cada compra y procesar los datos
      const comprasConInfo = [];
      let pendientes = compras.length;

      compras.forEach(compra => {
        const productInfoPath = `${CFI}/Products/${compra.producto_id}/info.txt`;


        // Leer el archivo `info.txt`
        fs.readFile(productInfoPath, 'utf8', (err, data) => {
          let info = {};
          if (!err && data) {
            // Procesar el contenido del archivo si existe
            const infoLines = data.split('\n');
            infoLines.forEach(line => {
              const [key, value] = line.split(': ');
              if (key && value) {
                info[key.trim()] = value.trim();
              }
            });
          }

          // Verifica que `producto_id` exista y no sea nulo
          const productoId = compra.producto_id || 'default';

          // Agregar la compra con la información procesada
          const direccionParts = compra.direccion_envio.split(', ');
          comprasConInfo.push({
            ...compra,
            producto: {
              nombre: compra.producto_nombre,
              precio: compra.producto_precio,
              categoria: compra.producto_categoria,
              codigo: compra.producto_codigo,
              path_imagen: `${CFI}/Products/${productoId}/a.webp`

            },
            info,
            direccion: {
              calle: direccionParts[0] || 'N/A',
              ciudad: direccionParts[1] || 'N/A',
              estado: direccionParts[2] || 'N/A',
              codigoPostal: direccionParts[3] || 'N/A'
            }
          });

          // Verificar si se procesaron todas las compras
          pendientes--;
          if (pendientes === 0) {
            res.render('compras', {
              ordenes,
              compras: comprasConInfo,
              mensaje: null,
              searchQuery: ''
            });
          }
        });
      });
    });
  });
});

//########################################## BUSQUEDA COMPRAS ##################################################
app.get('/comprasbuscar', (req, res) => {
  const userId = req.session.userId;

  // Redireccionar ?=pablo a ?q=pablo
  if (req.query[''] && !req.query.q) {
    return res.redirect(`/comprasbuscar?q=${req.query['']}`);
  }

  const searchQuery = req.query.q || ''; // Captura 'q'

  if (!userId) {
    return res.redirect('/login');
  }

  // Consulta para buscar órdenes basadas en la referencia o productos
  const queryordenes = `
    SELECT 
      ordenes.orden_id,
      ordenes.numero_orden,
      ordenes.referencia,
      ordenes.fecha_orden
    FROM 
      ordenes
    LEFT JOIN 
      Compras
      ON ordenes.orden_id = Compras.orden_id
    LEFT JOIN 
      Productos
      ON Compras.producto_id = Productos.producto_id
    WHERE 
      ordenes.usuario_id = ? AND
      (ordenes.referencia LIKE ? OR Productos.nombre LIKE ?)
  `;

  const valuesordenes = [userId, `%${searchQuery}%`, `%${searchQuery}%`];

  db.query(queryordenes, valuesordenes, (error, ordenes) => {
    if (error) {
      console.error('Error al consultar órdenes:', error);
      return res.status(500).send('Error interno del servidor');
    }

    if (ordenes.length === 0) {
      return res.render('compras', { ordenes: [], compras: [], mensaje: 'No se encontraron resultados.', searchQuery });
    }

    const ordenIds = Array.from(new Set(ordenes.map(orden => orden.orden_id))); // Eliminar duplicados

    // Consulta solo las compras que coinciden con el término buscado
    const queryCompras = `
      SELECT 
        Compras.*, 
        Productos.nombre AS producto_nombre, 
        Productos.precio AS producto_precio, 
        Productos.categoria AS producto_categoria, 
        Productos.codigo AS producto_codigo,
        Productos.producto_id AS producto_id 
      FROM 
        Compras 
      LEFT JOIN 
        Productos 
      ON 
        Compras.producto_id = Productos.producto_id 
      WHERE 
        Compras.orden_id IN (?) AND
        (Productos.nombre LIKE ?)
    `;

    const valuesCompras = [ordenIds, `%${searchQuery}%`];

    db.query(queryCompras, valuesCompras, (error, compras) => {
      if (error) {
        console.error('Error al consultar compras:', error);
        return res.status(500).send('Error interno del servidor');
      }

      const comprasConInfo = [];
      let pendientes = compras.length;

      if (compras.length === 0) {
        return res.render('compras', {
          ordenes: ordenes, // Ordenes sin duplicados
          compras: [],
          mensaje: 'No se encontraron compras asociadas a las órdenes.',
          searchQuery
        });
      }

      compras.forEach((compra) => {
        const productInfoPath = `${CFI}/Products/${compra.producto_id}/info.txt`;


        fs.readFile(productInfoPath, 'utf8', (err, data) => {
          let info = {};
          if (!err && data) {
            const infoLines = data.split('\n');
            infoLines.forEach((line) => {
              const [key, value] = line.split(': ');
              if (key && value) {
                info[key.trim()] = value.trim();
              }
            });
          }

          const productoId = compra.producto_id || 'default';

          const direccionParts = compra.direccion_envio.split(', ');
          comprasConInfo.push({
            ...compra,
            producto: {
              nombre: compra.producto_nombre,
              precio: compra.producto_precio,
              categoria: compra.producto_categoria,
              codigo: compra.producto_codigo,
              path_imagen: `${CFI}/Products/${productoId}/a.webp`,

            },
            info,
            direccion: {
              calle: direccionParts[0] || 'N/A',
              ciudad: direccionParts[1] || 'N/A',
              estado: direccionParts[2] || 'N/A',
              codigoPostal: direccionParts[3] || 'N/A',
            },
          });

          pendientes--;
          if (pendientes === 0) {
            res.render('compras', {
              ordenes: ordenes, // Sin duplicados
              compras: comprasConInfo,
              mensaje: null,
              searchQuery,
            });
          }
        });
      });
    });
  });
});




//########################################## Catálogo ##################################################
app.get('/producto', async (req, res) => {
  const productoId = req.query.id;

  try {
    // Paso 1: Consultar el producto en la base de datos
    const [results] = await db.promise().query('SELECT * FROM Productos WHERE producto_id = ?', [productoId]);

    if (results.length === 0) {
      return res.status(404).send('Producto no encontrado');
    }

    const producto = results[0];

    // Paso 2: Leer el archivo info.txt desde Cloudflare R2
    const productInfoPath = `${CFI}/Products/${productoId}/info.txt`;

    let data;
    try {
      const response = await fetch(productInfoPath);
      if (!response.ok) {
        throw new Error(`Error fetching file: ${response.statusText}`);
      }
      data = await response.text();
    } catch (err) {
      console.error('Error fetching file:', err);
      return res.status(500).send('Error interno al obtener la información del producto');
    }

    // Paso 3: Procesar el contenido del archivo info.txt
    const infoLines = data.split('\n');
    const info = {};
    let currentSection = null;

    infoLines.forEach(line => {
      if (line.trim() === "Información Básica") {
        currentSection = "basic";
        info[currentSection] = {};
      } else if (line.trim() === "Información de Catálogo") {
        currentSection = "catalog";
        info[currentSection] = {};
      } else if (line.trim() !== "") {
        const [key, value] = line.split(': ');
        if (currentSection && key && value) {
          info[currentSection][key.trim()] = value.trim();
        }
      }
    });

    // Paso 4: Seleccionar tres productos relacionados al azar de la misma categoría
    const [relatedProducts] = await db.promise().query(
      'SELECT * FROM Productos WHERE categoria = ? AND producto_id != ? ORDER BY RAND() LIMIT 3',
      [producto.categoria, productoId]
    );

    // Paso 5: Renderizar la plantilla EJS con los datos del producto, archivo y productos relacionados
    res.render('producto', {
      producto,
      descripcion1: info.catalog ? info.catalog['Descripción 1'] : 'No disponible',
      descripcion2: info.catalog ? info.catalog['Descripción 2'] : 'No disponible',
      material: info.basic ? info.basic['Material'] : 'No disponible',
      dimensiones: info.basic ? info.basic['Dimensiones'] : 'No disponible',
      acabado: info.basic ? info.basic['Acabado'] : 'No disponible',
      color: info.basic ? info.basic['Color'] : 'No disponible',
      productosRelacionados: relatedProducts
    });
  } catch (err) {
    console.error('Error en el servidor:', err);
    res.status(500).send('Error interno del servidor');
  }
});




app.get('/catalogo', (req, res) => {
  const productosPorPagina = 12;
  const paginaActual = parseInt(req.query.page) || 1;
  const offset = (paginaActual - 1) * productosPorPagina;
  const categoriaSeleccionada = req.query.categoria || 'Todos'; // Por defecto "Todos"
  const searchQuery = req.query.query || ''; // Verificar si hay término de búsqueda

  // Consulta base de productos, ahora incluye el campo stock
  let queryProductos = 'SELECT producto_id, nombre, precio, codigo, stock FROM Productos WHERE 1=1';
  let values = [];

  // Si la categoría no es "Todos", aplicar el filtro
  if (categoriaSeleccionada && categoriaSeleccionada !== 'Todos') {
    queryProductos += ' AND categoria = ?';
    values.push(categoriaSeleccionada);
  }

  // Añadir filtro de búsqueda si hay un término de búsqueda
  if (searchQuery) {
    queryProductos += ' AND nombre LIKE ?';
    values.push(`%${searchQuery}%`);
  }

  // Añadir límite y desplazamiento para la paginación
  queryProductos += ' LIMIT ? OFFSET ?';
  values.push(productosPorPagina, offset);

  // Consultar productos con la búsqueda o la categoría
  db.query(queryProductos, values, (err, productos) => {
    if (err) {
      console.error('Error fetching products:', err);
      return res.status(500).send('Error fetching products');
    }

    // Añadir la lógica para obtener la imagen principal de cada producto
    productos.forEach(producto => {
      
      producto.imagePath = `${CFI}/Products/${producto.producto_id}/a.webp`;
      
    });

    // Consulta para contar el número total de productos
    let queryCount = 'SELECT COUNT(*) AS total FROM Productos WHERE 1=1';
    let countValues = [];

    // Aplicar la lógica para la categoría en el conteo de productos, excepto si es "Todos"
    if (categoriaSeleccionada && categoriaSeleccionada !== 'Todos') {
      queryCount += ' AND categoria = ?';
      countValues.push(categoriaSeleccionada);
    }

    if (searchQuery) {
      queryCount += ' AND nombre LIKE ?';
      countValues.push(`%${searchQuery}%`);
    }

    // Ejecutar la consulta de conteo de productos
    db.query(queryCount, countValues, (err, countResults) => {
      if (err) {
        console.error('Error counting products:', err);
        return res.status(500).send('Error counting products');
      }

      const totalProductos = countResults[0].total;
      const totalPaginas = Math.ceil(totalProductos / productosPorPagina);

      // Consulta para contar las categorías
      let queryCategorias = 'SELECT categoria, COUNT(*) AS cantidad FROM Productos GROUP BY categoria';

      db.query(queryCategorias, (err, categorias) => {
        if (err) {
          console.error('Error fetching categories:', err);
          return res.status(500).send('Error fetching categories');
        }

        // Añadir manualmente la categoría "Todos" al principio de la lista
        const totalProductosQuery = 'SELECT COUNT(*) AS cantidad FROM Productos';
        db.query(totalProductosQuery, (err, resultadoTotal) => {
          if (err) {
            console.error('Error fetching total product count:', err);
            return res.status(500).send('Error fetching total product count');
          }

          const totalProductosEnDB = resultadoTotal[0].cantidad;

          // Agregar "Todos" como categoría manualmente
          categorias.unshift({ categoria: 'Todos', cantidad: totalProductosEnDB });

          // Renderizar la vista
          res.render('catalogo', {
            productos: productos,
            paginaActual: paginaActual,
            totalPaginas: totalPaginas,
            categorias: categorias, // Enviar categorías con la cantidad de productos
            categoriaSeleccionada: categoriaSeleccionada, // Pasar la categoría seleccionada
            searchQuery: searchQuery // Pasar el término de búsqueda
          });
        });
      });
    });
  });
});

app.get('/buscar', (req, res) => {
  const searchQuery = req.query.query; // Obtener la consulta de búsqueda
  const productosPorPagina = 12; // Número de productos por página
  const paginaActual = parseInt(req.query.page) || 1; // Página actual (por defecto la 1)
  const offset = (paginaActual - 1) * productosPorPagina;

  const query = `SELECT producto_id, nombre, precio, codigo FROM Productos WHERE nombre LIKE ? OR codigo LIKE ? LIMIT ? OFFSET ?`;
  const values = [`%${searchQuery}%`, `%${searchQuery}%`, productosPorPagina, offset];

  db.query(query, values, (err, results) => {
    if (err) {
      console.error('Error during search:', err);
      return res.status(500).send('Error fetching products');
    }

    // Obtener el número total de productos que coinciden con la búsqueda
    db.query(`SELECT COUNT(*) AS total FROM Productos WHERE nombre LIKE ? OR codigo LIKE ?`, [`%${searchQuery}%`, `%${searchQuery}%`], (err, countResults) => {
      if (err) {
        console.error('Error counting products:', err);
        return res.status(500).send('Error counting products');
      }

      const totalProductos = countResults[0].total;
      const totalPaginas = Math.ceil(totalProductos / productosPorPagina);

      // Renderizar la vista con los productos encontrados, y los valores de paginación
      res.render('catalogo', {
        productos: results,
        paginaActual: paginaActual,
        totalPaginas: totalPaginas,
        searchQuery: searchQuery // Pasar también la consulta de búsqueda
      });
    });
  });
});


//################################################## INICIO DE SESION ##################################################


app.use(express.urlencoded({ extended: true }));
app.use(express.json());



// Middleware global para que el correo del usuario esté disponible en todas las vistas
app.use((req, res, next) => {
  res.locals.correo = req.session.correo || null; // Si hay una sesión activa, pasa el correo del usuario, si no, es null
  next();
});


// Ruta para mostrar la página de inicio de sesión
app.get('/login', (req, res) => {
  res.render('login'); // Renderiza la vista login.ejs
});

// Ruta para mostrar la página de creación de cuenta
app.get('/crear-cuenta', (req, res) => {
  res.render('crear-cuenta'); // Renderiza la vista crear-cuenta.ejs
});


// Ruta para verificar el estado de la sesión
// Ruta para verificar el estado de la sesión
app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    // Si hay una sesión activa, devolver el correo del usuario
    res.json({ isAuthenticated: true, correo: req.session.correo });
  } else {
    // Si no hay una sesión activa
    res.json({ isAuthenticated: false });
  }
});

// Ruta para manejar el inicio de sesión
// Ruta para manejar el inicio de sesión
app.post('/login', (req, res) => {
  //console.log('Datos recibidos del formulario:', req.body);
  const { correo, password } = req.body;

  if (!correo || !password) {
      console.error('Faltan datos:', req.body);
      return res.status(400).send('Correo y contraseña son obligatorios');
  }

  db.query('SELECT * FROM Usuarios WHERE correo = ?', [correo], (err, results) => {
      if (err) {
          //console.error('Error fetching user:', err);
          return res.status(500).send('Error interno del servidor');
      }

      if (results.length === 0) {
          //console.warn('Usuario no encontrado:', correo);
          return res.status(401).send('Correo o contraseña incorrectos');
      }

      const user = results[0];

      //console.log('Contraseña ingresada:', password);
      //console.log('Contraseña almacenada:', user.password);

      bcrypt.compare(password, user.password, (err, isMatch) => {
          if (err) {
              console.error('Error comparing passwords:', err);
              return res.status(500).send('Error interno del servidor');
          }

          if (!isMatch) {
              console.warn('Contraseña no coincide para el usuario:', correo);
              return res.status(401).send('Correo o contraseña incorrectos');
          }

          req.session.userId = user.usuario_id;
          req.session.nombre = user.nombre;
          req.session.correo = user.correo;

          console.log('Inicio de sesión exitoso:', user.nombre);
          res.redirect('/');
      });
  });
});


app.post('/crear-cuenta', (req, res) => {
  const { nombre, correo, telefono, password } = req.body;

  // Verifica que todos los campos estén presentes
  if (!nombre || !correo || !telefono || !password) {
    return res.status(400).send('Todos los campos son obligatorios');
  }

  // Verifica si el correo ya está en uso
  db.query('SELECT * FROM Usuarios WHERE correo = ?', [correo], (err, results) => {
    if (err) {
      console.error('Error checking email:', err);
      return res.status(500).send('Error interno del servidor');
    }

    if (results.length > 0) {
      // Si el correo ya está en uso, devuelve un error
      return res.status(400).send('El correo ya está en uso');
    }

    // Encripta la contraseña antes de guardarla
    bcrypt.hash(password, 10, (err, hashedPassword) => {
      if (err) {
        console.error('Error hashing password:', err);
        return res.status(500).send('Error interno del servidor');
      }

      // Inserta el nuevo usuario en la base de datos
      db.query(
        'INSERT INTO Usuarios (nombre, correo, telefono, password) VALUES (?, ?, ?, ?)',
        [nombre, correo, telefono, hashedPassword],
        (err, result) => {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).send('Error al crear la cuenta');
          }

          // Redirige al usuario a la página de inicio de sesión después de crear la cuenta
          res.redirect('/login');
        }
      );
    });
  });
});


app.get('/logout', (req, res) => {
  // Renderiza una página que pide confirmación
  res.render('confirm_logout'); // Enviamos la vista confirm_logout.ejs
});

app.post('/logout', (req, res) => {
  // Solo se ejecuta si el usuario confirma
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Error al cerrar la sesión');
    }
    // Redirige al usuario al inicio después de cerrar sesión
    res.redirect('/');
  });
});


app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});