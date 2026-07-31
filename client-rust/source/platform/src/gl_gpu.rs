//! OpenGL implementation of the Gpu trait.

use std::collections::HashMap;
use successor_engine_render::gpu::{
    BufferId, BufferUsage, ClearSpec, Cull, Filter, ForwardLight, Gpu, GpuCaps, GpuError,
    MinFilter, MrtDesc, PassTarget, PipelineState, ProgramId, RectPx, RenderTargetDesc,
    RenderTargetId, Texture3dDesc, TextureDesc, TextureFormat, TextureId, Uniform, UniformValue,
    VertexFormat, VertexLayout, Wrap,
};

#[cfg(not(target_arch = "wasm32"))]
use crate::native::gl;

#[cfg(target_arch = "wasm32")]
use crate::web::gl;

struct RenderTarget {
    fbo: u32,
    colors: Vec<TextureId>,
    depth_tex: Option<TextureId>,
}

pub struct GlGpu {
    #[allow(dead_code)]
    vao: u32,
    uniform_cache: HashMap<u32, HashMap<&'static str, i32>>,
    render_targets: Vec<RenderTarget>,
    active_program: u32,
    caps: successor_engine_render::gpu::GpuCaps,
    error: Option<GpuError>,
}

impl Default for GlGpu {
    fn default() -> Self {
        Self::new()
    }
}

impl GlGpu {
    pub fn new() -> Self {
        let vao = gl::gen_vertex_array();
        gl::bind_vertex_array(vao);

        Self {
            vao,
            uniform_cache: HashMap::new(),
            render_targets: Vec::new(),
            active_program: 0,
            caps: successor_engine_render::gpu::GpuCaps {
                half_float_target: gl::cap_half_float_target(),
                max_color_attachments: gl::get_integer(gl::MAX_COLOR_ATTACHMENTS).max(0) as u32,
                max_draw_buffers: gl::get_integer(gl::MAX_DRAW_BUFFERS).max(0) as u32,
            },
            error: None,
        }
    }
}

impl Gpu for GlGpu {
    fn create_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId {
        let handle = gl::gen_buffer();
        let gl_usage = match usage {
            BufferUsage::Static => gl::STATIC_DRAW,
            BufferUsage::Dynamic => gl::DYNAMIC_DRAW,
        };
        gl::bind_buffer(gl::ARRAY_BUFFER, handle);
        gl::buffer_data(gl::ARRAY_BUFFER, data, gl_usage);
        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
        BufferId(handle)
    }

    fn create_index_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId {
        let handle = gl::gen_buffer();
        let gl_usage = match usage {
            BufferUsage::Static => gl::STATIC_DRAW,
            BufferUsage::Dynamic => gl::DYNAMIC_DRAW,
        };
        // Bind as ELEMENT_ARRAY_BUFFER on creation so WebGL2 fixes its type as an
        // index buffer (a buffer first bound to ARRAY_BUFFER can't be rebound).
        gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, handle);
        gl::buffer_data(gl::ELEMENT_ARRAY_BUFFER, data, gl_usage);
        gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, 0);
        BufferId(handle)
    }

    fn update_buffer(&mut self, id: BufferId, data: &[u8]) {
        gl::bind_buffer(gl::ARRAY_BUFFER, id.0);
        gl::buffer_data(gl::ARRAY_BUFFER, data, gl::DYNAMIC_DRAW);
        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
    }

    fn create_program(&mut self, vert_src: &str, frag_src: &str) -> ProgramId {
        let header = if cfg!(target_arch = "wasm32") {
            "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler3D;\n"
        } else {
            "#version 330 core\n"
        };

        let vert_full = format!("{}{}", header, vert_src);
        let frag_full = format!("{}{}", header, frag_src);

        let vs = gl::create_shader(gl::VERTEX_SHADER);
        gl::shader_source(vs, vert_full.as_bytes());
        gl::compile_shader(vs);

        let vs_ok = gl::get_shaderiv(vs, gl::COMPILE_STATUS);
        if vs_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_shader_info_log(vs, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Vertex shader compile error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
            self.error.get_or_insert(GpuError::ShaderCompile);
        }

        let fs = gl::create_shader(gl::FRAGMENT_SHADER);
        gl::shader_source(fs, frag_full.as_bytes());
        gl::compile_shader(fs);

        let fs_ok = gl::get_shaderiv(fs, gl::COMPILE_STATUS);
        if fs_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_shader_info_log(fs, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Fragment shader compile error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
            self.error.get_or_insert(GpuError::ShaderCompile);
        }

        let program = gl::create_program();
        gl::attach_shader(program, vs);
        gl::attach_shader(program, fs);
        gl::link_program(program);

        let link_ok = gl::get_programiv(program, gl::LINK_STATUS);
        if link_ok == 0 {
            let mut info = [0u8; 1024];
            let len = gl::get_program_info_log(program, &mut info);
            let log_msg = std::str::from_utf8(&info[..len]).unwrap_or("unknown error");
            successor_engine_core::rt::log::log_str("Program link error:\n");
            successor_engine_core::rt::log::log_str(log_msg);
            successor_engine_core::rt::log::log_str("\n");
            self.error.get_or_insert(GpuError::ProgramLink);
        }

        gl::delete_shader(vs);
        gl::delete_shader(fs);

        ProgramId(program)
    }

    fn create_texture(&mut self, desc: &TextureDesc, data: Option<&[u8]>) -> TextureId {
        if desc.width == 0 || desc.height == 0 {
            self.error.get_or_insert(GpuError::InvalidResource);
        }
        let handle = gl::gen_texture();
        gl::bind_texture(gl::TEXTURE_2D, handle);
        gl::pixel_storei(gl::UNPACK_ALIGNMENT, 1);

        let mag_filter = match desc.mag_filter {
            Filter::Nearest => gl::NEAREST,
            Filter::Linear => gl::LINEAR,
        };
        let min_filter = match desc.min_filter {
            MinFilter::Nearest => gl::NEAREST,
            MinFilter::Linear => gl::LINEAR,
            MinFilter::NearestMipmapNearest => gl::NEAREST_MIPMAP_NEAREST,
            MinFilter::LinearMipmapLinear => gl::LINEAR_MIPMAP_LINEAR,
        };
        let wrap = |mode| match mode {
            Wrap::ClampToEdge => gl::CLAMP_TO_EDGE,
            Wrap::Repeat => gl::REPEAT,
        };
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, min_filter);
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, mag_filter);
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, wrap(desc.wrap_s));
        gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, wrap(desc.wrap_t));

        let (internal_format, format, ty) = match desc.format {
            TextureFormat::Rgba8 => (gl::RGBA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
            TextureFormat::Srgba8 => (gl::SRGB8_ALPHA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
            TextureFormat::R8 => (gl::R8 as i32, gl::RED, gl::UNSIGNED_BYTE),
            TextureFormat::Rg8 => (gl::RG8 as i32, gl::RG, gl::UNSIGNED_BYTE),
            TextureFormat::Rgba16F => (gl::RGBA16F as i32, gl::RGBA, gl::HALF_FLOAT),
            TextureFormat::Depth => (
                gl::DEPTH_COMPONENT24 as i32,
                gl::DEPTH_COMPONENT,
                gl::UNSIGNED_INT,
            ),
        };

        gl::tex_image_2d(
            gl::TEXTURE_2D,
            0,
            internal_format,
            desc.width as i32,
            desc.height as i32,
            0,
            format,
            ty,
            data,
        );
        if desc.mipmaps {
            gl::generate_mipmap(gl::TEXTURE_2D);
        }

        gl::bind_texture(gl::TEXTURE_2D, 0);
        TextureId(handle)
    }

    fn create_render_target(&mut self, desc: &RenderTargetDesc) -> RenderTargetId {
        let fbo = gl::gen_framebuffer();
        gl::bind_framebuffer(gl::FRAMEBUFFER, fbo);

        let filter = match desc.filter {
            Filter::Nearest => gl::NEAREST,
            Filter::Linear => gl::LINEAR,
        };

        let color_tex = if desc.color {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                gl::RGBA8 as i32,
                desc.width as i32,
                desc.height as i32,
                0,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                None,
            );
            gl::framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                gl::COLOR_ATTACHMENT0,
                gl::TEXTURE_2D,
                handle,
                0,
            );
            Some(TextureId(handle))
        } else {
            None
        };

        let depth_tex = if desc.depth {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                gl::DEPTH_COMPONENT24 as i32,
                desc.width as i32,
                desc.height as i32,
                0,
                gl::DEPTH_COMPONENT,
                gl::UNSIGNED_INT,
                None,
            );
            gl::framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                gl::DEPTH_ATTACHMENT,
                gl::TEXTURE_2D,
                handle,
                0,
            );
            Some(TextureId(handle))
        } else {
            None
        };

        if !desc.color {
            gl::disable_draw_buffer();
        }

        let status = gl::check_framebuffer_status(gl::FRAMEBUFFER);
        if status != gl::FRAMEBUFFER_COMPLETE {
            successor_engine_core::rt::log::log1u("Framebuffer incomplete status: ", status as u64);
            successor_engine_core::rt::log::log_str("\n");
            self.error.get_or_insert(GpuError::IncompleteFramebuffer);
        }

        gl::bind_framebuffer(gl::FRAMEBUFFER, 0);

        let rt_idx = self.render_targets.len() as u32 + 1;
        self.render_targets.push(RenderTarget {
            fbo,
            colors: color_tex.into_iter().collect(),
            depth_tex,
        });

        RenderTargetId(rt_idx)
    }

    fn render_target_color(&self, rt: RenderTargetId) -> Option<TextureId> {
        let idx = rt.0 as usize - 1;
        if idx < self.render_targets.len() {
            self.render_targets[idx].colors.first().copied()
        } else {
            None
        }
    }

    fn render_target_depth(&self, rt: RenderTargetId) -> Option<TextureId> {
        let idx = rt.0 as usize - 1;
        if idx < self.render_targets.len() {
            self.render_targets[idx].depth_tex
        } else {
            None
        }
    }

    fn begin_pass(&mut self, target: PassTarget, viewport: RectPx, clear: ClearSpec) {
        match target {
            PassTarget::Screen => {
                gl::bind_framebuffer(gl::FRAMEBUFFER, 0);
            }
            PassTarget::RenderTarget(rt_id) => {
                let idx = rt_id.0 as usize - 1;
                if idx < self.render_targets.len() {
                    gl::bind_framebuffer(gl::FRAMEBUFFER, self.render_targets[idx].fbo);
                }
            }
        }
        gl::viewport(viewport.x, viewport.y, viewport.w, viewport.h);

        let mut mask = 0;
        if let Some(color) = clear.color {
            gl::clear_color(color[0], color[1], color[2], color[3]);
            mask |= gl::COLOR_BUFFER_BIT;
        }
        if clear.depth.is_some() {
            gl::depth_mask(true);
            mask |= gl::DEPTH_BUFFER_BIT;
        }
        if mask != 0 {
            gl::clear(mask);
        }
    }

    fn set_pipeline(&mut self, program: ProgramId, state: &PipelineState) {
        gl::use_program(program.0);
        self.active_program = program.0;

        if state.depth_test {
            gl::enable(gl::DEPTH_TEST);
        } else {
            gl::disable(gl::DEPTH_TEST);
        }

        gl::depth_mask(state.depth_write);

        match state.cull {
            Cull::None => {
                gl::disable(gl::CULL_FACE);
            }
            Cull::Back => {
                gl::enable(gl::CULL_FACE);
                gl::cull_face(gl::BACK);
            }
            Cull::Front => {
                gl::enable(gl::CULL_FACE);
                gl::cull_face(gl::FRONT);
            }
        }

        gl::color_mask(
            state.color_write,
            state.color_write,
            state.color_write,
            state.color_write,
        );

        if state.blend {
            gl::enable(gl::BLEND);
            if state.additive {
                gl::blend_func(gl::SRC_ALPHA, gl::ONE);
            } else {
                gl::blend_func(gl::SRC_ALPHA, gl::ONE_MINUS_SRC_ALPHA);
            }
        } else {
            gl::disable(gl::BLEND);
        }
    }

    fn set_uniforms(&mut self, uniforms: &[Uniform]) {
        let program = self.active_program;
        if program == 0 {
            return;
        }

        // Safe steady-state lock-free lookup
        let has_key = if let Some(cache) = self.uniform_cache.get(&program) {
            let mut all_found = true;
            for u in uniforms {
                if !cache.contains_key(u.name) {
                    all_found = false;
                    break;
                }
            }
            all_found
        } else {
            false
        };

        if !has_key {
            // Allocate once during first frame or load
            let cache = self.uniform_cache.entry(program).or_default();
            for u in uniforms {
                if !cache.contains_key(u.name) {
                    let loc = gl::get_uniform_location(program, u.name);
                    cache.insert(u.name, loc);
                }
            }
        }

        let cache = self.uniform_cache.get(&program).unwrap();
        for u in uniforms {
            if let Some(&loc) = cache.get(u.name) {
                if loc == -1 {
                    continue;
                }
                match u.value {
                    UniformValue::Float(v) => gl::uniform1f(loc, v),
                    UniformValue::Vec3(v) => gl::uniform3f(loc, v[0], v[1], v[2]),
                    UniformValue::Vec2(v) => gl::uniform2f(loc, v[0], v[1]),
                    UniformValue::Vec4(v) => gl::uniform4f(loc, v[0], v[1], v[2], v[3]),
                    UniformValue::Mat4(v) => gl::uniform_matrix4fv(loc, false, &v),
                    UniformValue::Int(v) => gl::uniform1i(loc, v),
                    UniformValue::Sampler(v) => gl::uniform1i(loc, v),
                }
            }
        }
    }

    fn bind_texture(&mut self, slot: u32, tex: TextureId) {
        gl::active_texture(gl::TEXTURE0 + slot);
        gl::bind_texture(gl::TEXTURE_2D, tex.0);
    }

    fn draw(
        &mut self,
        vertices: BufferId,
        indices: Option<BufferId>,
        layout: &VertexLayout,
        count: u32,
    ) {
        gl::bind_buffer(gl::ARRAY_BUFFER, vertices.0);

        for attr in layout.attrs {
            gl::enable_vertex_attrib_array(attr.location);
            let (scalar, normalized) = match attr.format {
                VertexFormat::F32 => (gl::FLOAT, false),
                VertexFormat::U8 => (gl::UNSIGNED_BYTE, false),
                VertexFormat::U8Norm => (gl::UNSIGNED_BYTE, true),
                VertexFormat::U16Norm => (gl::UNSIGNED_SHORT, true),
            };
            gl::vertex_attrib_pointer(
                attr.location,
                attr.components as i32,
                scalar,
                normalized,
                layout.stride as i32,
                attr.offset,
            );
        }

        if let Some(ebo) = indices {
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, ebo.0);
            gl::draw_elements(gl::TRIANGLES, count as i32, gl::UNSIGNED_INT, 0);
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, 0);
        } else {
            gl::draw_arrays(gl::TRIANGLES, 0, count as i32);
        }

        for attr in layout.attrs {
            gl::disable_vertex_attrib_array(attr.location);
        }

        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
    }

    fn set_joints(&mut self, mats: &[[f32; 16]]) {
        let program = self.active_program;
        if program == 0 || mats.is_empty() {
            return;
        }
        let name = "u_joints";
        let loc = match self
            .uniform_cache
            .get(&program)
            .and_then(|c| c.get(name).copied())
        {
            Some(l) => l,
            None => {
                let l = gl::get_uniform_location(program, name);
                self.uniform_cache
                    .entry(program)
                    .or_default()
                    .insert(name, l);
                l
            }
        };
        if loc == -1 {
            return;
        }
        let flat =
            unsafe { std::slice::from_raw_parts(mats.as_ptr() as *const f32, mats.len() * 16) };
        gl::uniform_matrix4fv_array(loc, flat);
    }

    fn set_forward_lights(&mut self, lights: &[ForwardLight]) {
        let program = self.active_program;
        if program == 0 {
            return;
        }
        let count = lights.len().min(32);
        if count == 0 {
            return;
        }
        let mut positions = [0.0; 96];
        let mut radii = [0.0; 32];
        let mut colors = [0.0; 96];
        let mut intensities = [0.0; 32];
        for (index, light) in lights[..count].iter().enumerate() {
            positions[index * 3..index * 3 + 3].copy_from_slice(&light.position);
            radii[index] = light.radius;
            colors[index * 3..index * 3 + 3].copy_from_slice(&light.color);
            intensities[index] = light.intensity;
        }
        for (name, kind) in [
            ("u_pointPositions[0]", 0u8),
            ("u_pointRadii[0]", 1),
            ("u_pointColors[0]", 2),
            ("u_pointIntensities[0]", 3),
        ] {
            let location = self
                .uniform_cache
                .get(&program)
                .and_then(|cache| cache.get(name).copied())
                .unwrap_or_else(|| {
                    let location = gl::get_uniform_location(program, name);
                    self.uniform_cache
                        .entry(program)
                        .or_default()
                        .insert(name, location);
                    location
                });
            if location == -1 {
                continue;
            }
            match kind {
                0 => gl::uniform3fv(location, &positions[..count * 3]),
                1 => gl::uniform1fv(location, &radii[..count]),
                2 => gl::uniform3fv(location, &colors[..count * 3]),
                _ => gl::uniform1fv(location, &intensities[..count]),
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_instanced(
        &mut self,
        vertices: BufferId,
        indices: Option<BufferId>,
        layout: &VertexLayout,
        index_count: u32,
        instance_buf: BufferId,
        instance_layout: &VertexLayout,
        instances: u32,
    ) {
        gl::bind_buffer(gl::ARRAY_BUFFER, vertices.0);
        for attr in layout.attrs {
            gl::enable_vertex_attrib_array(attr.location);
            let (scalar, normalized) = match attr.format {
                VertexFormat::F32 => (gl::FLOAT, false),
                VertexFormat::U8 => (gl::UNSIGNED_BYTE, false),
                VertexFormat::U8Norm => (gl::UNSIGNED_BYTE, true),
                VertexFormat::U16Norm => (gl::UNSIGNED_SHORT, true),
            };
            gl::vertex_attrib_pointer(
                attr.location,
                attr.components as i32,
                scalar,
                normalized,
                layout.stride as i32,
                attr.offset,
            );
        }
        // Per-instance attributes (divisor 1), described by `instance_layout`.
        gl::bind_buffer(gl::ARRAY_BUFFER, instance_buf.0);
        for attr in instance_layout.attrs {
            gl::enable_vertex_attrib_array(attr.location);
            gl::vertex_attrib_pointer(
                attr.location,
                attr.components as i32,
                gl::FLOAT,
                false,
                instance_layout.stride as i32,
                attr.offset,
            );
            gl::vertex_attrib_divisor(attr.location, 1);
        }
        if let Some(ebo) = indices {
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, ebo.0);
            gl::draw_elements_instanced(
                gl::TRIANGLES,
                index_count as i32,
                gl::UNSIGNED_INT,
                0,
                instances as i32,
            );
            gl::bind_buffer(gl::ELEMENT_ARRAY_BUFFER, 0);
        } else {
            gl::draw_arrays_instanced(gl::TRIANGLES, 0, index_count as i32, instances as i32);
        }
        for attr in instance_layout.attrs {
            gl::vertex_attrib_divisor(attr.location, 0);
            gl::disable_vertex_attrib_array(attr.location);
        }
        for attr in layout.attrs {
            gl::disable_vertex_attrib_array(attr.location);
        }
        gl::bind_buffer(gl::ARRAY_BUFFER, 0);
    }

    fn caps(&self) -> GpuCaps {
        self.caps
    }

    fn take_error(&mut self) -> Option<GpuError> {
        self.error.take()
    }

    fn create_texture_3d(&mut self, desc: &Texture3dDesc, data: Option<&[u8]>) -> TextureId {
        let handle = gl::gen_texture();
        gl::bind_texture(gl::TEXTURE_3D, handle);
        gl::pixel_storei(gl::UNPACK_ALIGNMENT, 1);
        let min_filter = if desc.mips {
            gl::LINEAR_MIPMAP_LINEAR
        } else {
            gl::LINEAR
        };
        gl::tex_parameteri(gl::TEXTURE_3D, gl::TEXTURE_MIN_FILTER, min_filter);
        gl::tex_parameteri(gl::TEXTURE_3D, gl::TEXTURE_MAG_FILTER, gl::LINEAR);
        let wrap_xz = if desc.wrap_xz {
            gl::REPEAT
        } else {
            gl::CLAMP_TO_EDGE
        };
        gl::tex_parameteri(gl::TEXTURE_3D, gl::TEXTURE_WRAP_S, wrap_xz);
        gl::tex_parameteri(gl::TEXTURE_3D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
        gl::tex_parameteri(gl::TEXTURE_3D, gl::TEXTURE_WRAP_R, wrap_xz);
        let (internal_format, format, ty) = match desc.format {
            TextureFormat::Rgba8 => (gl::RGBA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
            TextureFormat::Srgba8 => (gl::SRGB8_ALPHA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
            TextureFormat::R8 => (gl::R8 as i32, gl::RED, gl::UNSIGNED_BYTE),
            TextureFormat::Rg8 => (gl::RG8 as i32, gl::RG, gl::UNSIGNED_BYTE),
            TextureFormat::Rgba16F => (gl::RGBA16F as i32, gl::RGBA, gl::HALF_FLOAT),
            TextureFormat::Depth => (
                gl::DEPTH_COMPONENT24 as i32,
                gl::DEPTH_COMPONENT,
                gl::UNSIGNED_INT,
            ),
        };
        let s = desc.size as i32;
        gl::tex_image_3d(
            gl::TEXTURE_3D,
            0,
            internal_format,
            s,
            s,
            s,
            0,
            format,
            ty,
            data,
        );
        if desc.mips {
            gl::generate_mipmap(gl::TEXTURE_3D);
        }
        gl::bind_texture(gl::TEXTURE_3D, 0);
        TextureId(handle)
    }

    fn update_texture_3d_region(
        &mut self,
        id: TextureId,
        offset: [u32; 3],
        extent: [u32; 3],
        data: &[u8],
    ) {
        gl::bind_texture(gl::TEXTURE_3D, id.0);
        gl::pixel_storei(gl::UNPACK_ALIGNMENT, 1);
        gl::tex_sub_image_3d(
            gl::TEXTURE_3D,
            0,
            offset[0] as i32,
            offset[1] as i32,
            offset[2] as i32,
            extent[0] as i32,
            extent[1] as i32,
            extent[2] as i32,
            gl::RGBA,
            gl::UNSIGNED_BYTE,
            data,
        );
        gl::bind_texture(gl::TEXTURE_3D, 0);
    }

    fn generate_mipmaps_3d(&mut self, id: TextureId) {
        gl::bind_texture(gl::TEXTURE_3D, id.0);
        gl::generate_mipmap(gl::TEXTURE_3D);
        gl::bind_texture(gl::TEXTURE_3D, 0);
    }

    fn bind_texture_3d(&mut self, slot: u32, tex: TextureId) {
        gl::active_texture(gl::TEXTURE0 + slot);
        gl::bind_texture(gl::TEXTURE_3D, tex.0);
    }

    fn create_render_target_mrt(&mut self, desc: &MrtDesc) -> RenderTargetId {
        let fbo = gl::gen_framebuffer();
        gl::bind_framebuffer(gl::FRAMEBUFFER, fbo);
        let mut colors: Vec<TextureId> = Vec::with_capacity(desc.colors.len());
        let mut attachments: Vec<u32> = Vec::with_capacity(desc.colors.len());
        for (i, fmt) in desc.colors.iter().enumerate() {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            let (internal_format, format, ty) = match fmt {
                TextureFormat::Rgba8 => (gl::RGBA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
                TextureFormat::Srgba8 => (gl::SRGB8_ALPHA8 as i32, gl::RGBA, gl::UNSIGNED_BYTE),
                TextureFormat::R8 => (gl::R8 as i32, gl::RED, gl::UNSIGNED_BYTE),
                TextureFormat::Rg8 => (gl::RG8 as i32, gl::RG, gl::UNSIGNED_BYTE),
                TextureFormat::Rgba16F => (gl::RGBA16F as i32, gl::RGBA, gl::HALF_FLOAT),
                TextureFormat::Depth => (
                    gl::DEPTH_COMPONENT24 as i32,
                    gl::DEPTH_COMPONENT,
                    gl::UNSIGNED_INT,
                ),
            };
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                internal_format,
                desc.width as i32,
                desc.height as i32,
                0,
                format,
                ty,
                None,
            );
            let attach = gl::COLOR_ATTACHMENT0 + i as u32;
            gl::framebuffer_texture_2d(gl::FRAMEBUFFER, attach, gl::TEXTURE_2D, handle, 0);
            colors.push(TextureId(handle));
            attachments.push(attach);
        }
        let depth_tex = if desc.depth {
            let handle = gl::gen_texture();
            gl::bind_texture(gl::TEXTURE_2D, handle);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::NEAREST);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::NEAREST);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE);
            gl::tex_parameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE);
            gl::tex_image_2d(
                gl::TEXTURE_2D,
                0,
                gl::DEPTH_COMPONENT24 as i32,
                desc.width as i32,
                desc.height as i32,
                0,
                gl::DEPTH_COMPONENT,
                gl::UNSIGNED_INT,
                None,
            );
            gl::framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                gl::DEPTH_ATTACHMENT,
                gl::TEXTURE_2D,
                handle,
                0,
            );
            Some(TextureId(handle))
        } else {
            None
        };
        if attachments.is_empty() {
            gl::disable_draw_buffer();
        } else {
            gl::draw_buffers(&attachments);
        }
        let status = gl::check_framebuffer_status(gl::FRAMEBUFFER);
        if status != gl::FRAMEBUFFER_COMPLETE {
            successor_engine_core::rt::log::log1u(
                "MRT framebuffer incomplete status: ",
                status as u64,
            );
            successor_engine_core::rt::log::log_str("\n");
            self.error.get_or_insert(GpuError::IncompleteFramebuffer);
        }
        gl::bind_framebuffer(gl::FRAMEBUFFER, 0);
        let rt_idx = self.render_targets.len() as u32 + 1;
        self.render_targets.push(RenderTarget {
            fbo,
            colors,
            depth_tex,
        });
        RenderTargetId(rt_idx)
    }

    fn render_target_color_n(&self, rt: RenderTargetId, index: usize) -> Option<TextureId> {
        let idx = rt.0 as usize - 1;
        self.render_targets
            .get(idx)
            .and_then(|t| t.colors.get(index).copied())
    }

    fn delete_render_target(&mut self, rt: RenderTargetId) {
        let idx = rt.0 as usize - 1;
        if let Some(t) = self.render_targets.get_mut(idx) {
            gl::delete_framebuffer(t.fbo);
            for c in t.colors.drain(..) {
                gl::delete_texture(c.0);
            }
            if let Some(d) = t.depth_tex.take() {
                gl::delete_texture(d.0);
            }
            t.fbo = 0;
        }
    }

    fn finish(&mut self) {
        gl::finish();
    }

    fn end_pass(&mut self) {
        gl::bind_framebuffer(gl::FRAMEBUFFER, 0);
    }
}
